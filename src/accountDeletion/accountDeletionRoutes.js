import {
  deleteFirebaseUser,
  getFirebaseUser,
  verifyFirebaseToken,
  verifyFirebaseTokenSignature,
} from "../auth/firebase.js";
import { revokeAppleAuthorizationCredential } from "../auth/appleSignInService.js";
import { getDb } from "../db/db.js";
import { acquireKeyedLock } from "../utils/keyedLock.js";
import {
  AccountDeletionError,
  ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS,
  assertRecentAccountAuthentication,
  requestAccountDeletion,
  resumeAccountDeletion,
} from "./accountDeletionService.js";
import {
  getAccountDeletion,
  publicAccountNotRequested,
} from "./accountDeletionStore.js";

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
}

function firebaseUserHasAppleIdentity(firebaseUser) {
  return Boolean(
    firebaseUser?.providerData?.some(
      (provider) => provider?.providerId === "apple.com" && provider?.uid
    )
  );
}

function isFirebaseUserNotFound(error) {
  return error?.code === "auth/user-not-found";
}

function logRouteError(context, error) {
  console.error(context, {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
    status: Number.isFinite(error?.status) ? error.status : null,
  });
}

function sendAccountDeletionError(res, error, context) {
  logRouteError(context, error);
  if (error instanceof AccountDeletionError) {
    return res.status(error.status).json({
      code: error.code,
      error: error.message,
      ...(error.details || {}),
    });
  }
  return res.status(500).json({
    code: "ACCOUNT_DELETION_ERROR",
    error: "Account deletion could not be processed.",
  });
}

function sendDeletionResult(res, result) {
  return res.status(result?.deletionStatus === "complete" ? 200 : 202).json(
    result
  );
}

async function requireSignedToken(req, res, verifySignedTokenFn) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({
      code: "AUTH_REQUIRED",
      error: "Missing Bearer token",
    });
    return null;
  }

  try {
    const decoded = await verifySignedTokenFn(token);
    if (!decoded?.uid) throw new Error("Token is missing a UID");
    return {
      token,
      decoded,
    };
  } catch (error) {
    logRouteError("[account deletion signature authentication]", error);
    res.status(401).json({
      code: "AUTH_INVALID",
      error: "Invalid or expired token",
    });
    return null;
  }
}

function requestedUidMatches(req, res, decoded) {
  const requestedUid = String(req.params.uid || "").trim();
  if (!requestedUid) {
    res.status(400).json({ code: "UID_REQUIRED", error: "uid is required" });
    return null;
  }
  if (requestedUid !== decoded.uid) {
    res.status(403).json({ code: "UID_MISMATCH", error: "Forbidden" });
    return null;
  }
  return requestedUid;
}

export function attachAccountDeletionRoutes(
  app,
  {
    getDbFn = getDb,
    verifySignedTokenFn = verifyFirebaseTokenSignature,
    verifyActiveTokenFn = verifyFirebaseToken,
    getFirebaseUserFn = getFirebaseUser,
    deleteFirebaseUserFn = deleteFirebaseUser,
    revokeAppleCredentialFn = revokeAppleAuthorizationCredential,
    nowFn = Date.now,
  } = {}
) {
  app.get("/api/users/:uid/deletion-status", async (req, res) => {
    try {
      const authentication = await requireSignedToken(
        req,
        res,
        verifySignedTokenFn
      );
      if (!authentication) return;
      const uid = requestedUidMatches(req, res, authentication.decoded);
      if (!uid) return;

      const db = await getDbFn();
      let releaseAccountLock = null;
      const releaseResponseLock = () => releaseAccountLock?.();
      // Register before waiting for the lock. If the client disconnects while
      // another deletion owns it, the post-acquire destroyed check releases it
      // instead of leaving the keyed lock permanently occupied.
      res.once("finish", releaseResponseLock);
      res.once("close", releaseResponseLock);
      releaseAccountLock = await acquireKeyedLock(uid);
      if (res.destroyed || res.writableEnded) {
        releaseResponseLock();
        return;
      }
      const existing = await getAccountDeletion(db, uid);
      if (existing) {
        // The recovery service acquires this same lock. Release before
        // delegating so a status request never waits on itself.
        releaseResponseLock();
        const result = await resumeAccountDeletion(db, {
          uid,
          deleteFirebaseUserFn,
          revokeAppleCredentialFn,
          nowFn,
        });
        return sendDeletionResult(res, result);
      }

      // Keep a not-requested check serialized through response flush. A
      // concurrent DELETE may verify Firebase in parallel, but it cannot
      // create its durable tombstone until this response has finished.
      try {
        const activeDecoded = await verifyActiveTokenFn(authentication.token);
        if (!activeDecoded?.uid || activeDecoded.uid !== uid) {
          return res.status(403).json({
            code: "UID_MISMATCH",
            error: "Forbidden",
          });
        }
      } catch (error) {
        const racedDeletion = await getAccountDeletion(db, uid);
        if (racedDeletion) {
          releaseResponseLock();
          const result = await resumeAccountDeletion(db, {
            uid,
            deleteFirebaseUserFn,
            revokeAppleCredentialFn,
            nowFn,
          });
          return sendDeletionResult(res, result);
        }
        logRouteError("[deletion-status active authentication]", error);
        return res.status(401).json({
          code: "AUTH_INVALID",
          error: "This session is no longer active.",
        });
      }

      try {
        await getFirebaseUserFn(uid);
        return res.json(publicAccountNotRequested(uid));
      } catch (error) {
        if (isFirebaseUserNotFound(error)) {
          const racedDeletion = await getAccountDeletion(db, uid);
          if (racedDeletion) {
            releaseResponseLock();
            const result = await resumeAccountDeletion(db, {
              uid,
              deleteFirebaseUserFn,
              revokeAppleCredentialFn,
              nowFn,
            });
            return sendDeletionResult(res, result);
          }
          return res.status(404).json({
            code: "ACCOUNT_NOT_FOUND",
            error: "No Firebase account or deletion record was found.",
            uid,
            deletionStatus: "not_found",
          });
        }
        throw error;
      }
    } catch (error) {
      return sendAccountDeletionError(
        res,
        error,
        "[GET /api/users/:uid/deletion-status]"
      );
    }
  });

  app.delete("/api/users/:uid", async (req, res) => {
    try {
      const authentication = await requireSignedToken(
        req,
        res,
        verifySignedTokenFn
      );
      if (!authentication) return;
      const uid = requestedUidMatches(req, res, authentication.decoded);
      if (!uid) return;

      const db = await getDbFn();
      const existing = await getAccountDeletion(db, uid);
      let appleIdentityLinked = Boolean(existing?.apple_identity_linked);

      if (!existing) {
        let activeDecoded;
        try {
          activeDecoded = await verifyActiveTokenFn(authentication.token);
        } catch (error) {
          const racedDeletion = await getAccountDeletion(db, uid);
          if (racedDeletion) {
            const result = await requestAccountDeletion(db, {
              uid,
              appleIdentityLinked: Boolean(
                racedDeletion.apple_identity_linked
              ),
              deleteFirebaseUserFn,
              revokeAppleCredentialFn,
              nowFn,
            });
            return sendDeletionResult(res, result);
          }
          logRouteError("[account deletion active authentication]", error);
          return res.status(401).json({
            code: "AUTH_INVALID",
            error: "This session is no longer active.",
          });
        }
        if (activeDecoded?.uid !== uid) {
          return res.status(403).json({
            code: "UID_MISMATCH",
            error: "Forbidden",
          });
        }

        assertRecentAccountAuthentication(activeDecoded, {
          nowSeconds: Math.floor(nowFn() / 1_000),
        });

        try {
          const firebaseUser = await getFirebaseUserFn(uid);
          appleIdentityLinked = firebaseUserHasAppleIdentity(firebaseUser);
        } catch (error) {
          if (isFirebaseUserNotFound(error)) {
            const racedDeletion = await getAccountDeletion(db, uid);
            if (racedDeletion) {
              const result = await requestAccountDeletion(db, {
                uid,
                appleIdentityLinked: Boolean(
                  racedDeletion.apple_identity_linked
                ),
                deleteFirebaseUserFn,
                revokeAppleCredentialFn,
                nowFn,
              });
              return sendDeletionResult(res, result);
            }
            return res.status(404).json({
              code: "ACCOUNT_NOT_FOUND",
              error: "Firebase user not found",
            });
          }
          throw error;
        }
      }

      const result = await requestAccountDeletion(db, {
        uid,
        appleIdentityLinked,
        deleteFirebaseUserFn,
        revokeAppleCredentialFn,
        nowFn,
      });
      return sendDeletionResult(res, result);
    } catch (error) {
      return sendAccountDeletionError(
        res,
        error,
        "[DELETE /api/users/:uid]"
      );
    }
  });
}

export { ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS };
