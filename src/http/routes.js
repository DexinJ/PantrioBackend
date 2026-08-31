// src/http/routes.js
import express from "express";
import fetch, { Blob, FormData } from "node-fetch";
import multer from "multer";

import {
  verifyFirebaseToken,
  verifyFirebaseTokenSignature,
  getFirebaseUser,
} from "../auth/firebase.js";
import {
  AppleSignInError,
  linkAppleAuthorizationForUser,
} from "../auth/appleSignInService.js";
import { attachAccountDeletionRoutes } from "../accountDeletion/accountDeletionRoutes.js";
import {
  getAccountDeletion,
  publicAccountDeletion,
} from "../accountDeletion/accountDeletionStore.js";
import { OPENAI_API_KEY } from "../config/env.js";
import { getDb } from "../db/db.js";
import {
  MAX_CHAT_MESSAGES,
  MAX_CHAT_PAYLOAD_DEPTH,
  MAX_CHAT_PAYLOAD_NODES,
} from "../config/policy.js";
import {
  RecipeRecommendationError,
  recommendRecipes as runRecipeRecommendations,
} from "../chat/recipeRecommendations.js";
import { fetchPublicTextPage } from "../chat/safeWebFetch.js";
import { TOOLS } from "../chat/tools.js";
import {
  estimateAndApplyRecipeMetadata,
  recipeEstimationEnabled,
} from "../chat/recipeEstimation.js";
import { sanitizeRecipeContext } from "../chat/recipeRequest.js";
import {
  SubscriptionStatusValidationError,
  normalizeSubscriptionSnapshot,
} from "../subscriptions/subscriptionStatus.js";
import {
  getUserSubscription,
  saveUserSubscription,
} from "../subscriptions/subscriptionStore.js";
import { resolveSubscriptionAccess } from "../subscriptions/entitlementPolicy.js";
import {
  buildSession,
  ensureUserProfile,
} from "../session/sessionService.js";
import {
  AppleSubscriptionError,
  processAppleNotification,
  refreshAppleSubscriptionForUser,
  verifyAppleEvidenceForUser,
} from "../subscriptions/appleSubscriptionService.js";
import { AppleSubscriptionOwnershipError } from "../subscriptions/appleSubscriptionStore.js";
import {
  // addUsage, // Replaced by reservation reconciliation for quota-limited calls.
  getUsageRow,
  reconcileUsageReservation,
  reserveUsage,
} from "../usage/usageStore.js";
import {
  computeRemainingTokens,
  computeTokenBudget,
  estimateAudioTokensFromBytes,
  estimateTokensFromMessages,
} from "../usage/tokenBudget.js";
import {
  createQuotaSnapshot,
  getQuotaSnapshot,
  quotaLegacyFields,
} from "../usage/quotaSnapshot.js";
import { rateLimitStart } from "../utils/rateLimit.js";
import { createConcurrencyGuard } from "../utils/concurrencyGuard.js";
import { acquireKeyedLock } from "../utils/keyedLock.js";
import { inspectReadiness } from "../operations/readiness.js";

const MAX_AUDIO_FILE_SIZE = 2 * 1024 * 1024;
const TRANSCRIPTION_RATE_LIMIT = { windowMs: 60_000, max: 6 };
const SUMMARY_RATE_LIMIT = { windowMs: 60_000, max: 10 };
const RECIPE_RECOMMENDATION_RATE_LIMIT = { windowMs: 60_000, max: 6 };
const APPLE_VERIFICATION_RATE_LIMIT = { windowMs: 60_000, max: 10 };
const APPLE_AUTH_LINK_RATE_LIMIT = { windowMs: 60_000, max: 5 };
const MAX_CONCURRENT_APPLE_WEBHOOKS = 8;
const MAX_CONCURRENT_APPLE_VERIFICATIONS = 4;
const MAX_CONCURRENT_TRANSCRIPTIONS = 4;
const MAX_CONCURRENT_SUMMARIES = 8;
const MAX_CONCURRENT_RECIPE_RECOMMENDATIONS = 4;
const OPENAI_REST_TIMEOUT_MS = 90_000;
const limitConcurrentAppleWebhooks = createConcurrencyGuard({
  maxConcurrent: MAX_CONCURRENT_APPLE_WEBHOOKS,
  retryAfterSeconds: 5,
  code: "APPLE_WEBHOOK_BUSY",
  message: "Apple notification processing is temporarily busy.",
});
const limitConcurrentAppleVerifications = createConcurrencyGuard({
  maxConcurrent: MAX_CONCURRENT_APPLE_VERIFICATIONS,
  retryAfterSeconds: 5,
  code: "APPLE_VERIFICATION_BUSY",
  message: "Apple subscription verification is temporarily busy.",
});
const limitConcurrentTranscriptions = createConcurrencyGuard({
  maxConcurrent: MAX_CONCURRENT_TRANSCRIPTIONS,
  retryAfterSeconds: 5,
  code: "TRANSCRIPTION_BUSY",
  message: "The transcription service is temporarily busy.",
});
const limitConcurrentSummaries = createConcurrencyGuard({
  maxConcurrent: MAX_CONCURRENT_SUMMARIES,
  retryAfterSeconds: 5,
  code: "SUMMARY_BUSY",
  message: "The summary service is temporarily busy.",
});
const limitConcurrentRecipeRecommendations = createConcurrencyGuard({
  maxConcurrent: MAX_CONCURRENT_RECIPE_RECOMMENDATIONS,
  retryAfterSeconds: 5,
  code: "RECIPE_RECOMMENDATION_BUSY",
  message: "Recipe recommendations are temporarily busy.",
});

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
]);

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_FILE_SIZE,
    files: 1,
    fields: 0,
    parts: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!file?.mimetype) {
      callback(new Error("Uploaded audio file has no MIME type."));
      return;
    }

    if (!ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
      callback(
        new Error(`Unsupported audio file type: ${file.mimetype}`)
      );
      return;
    }

    callback(null, true);
  },
});

function getBearerToken(req) {
  const auth = req.headers.authorization || "";

  return auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : null;
}

function logErrorMetadata(context, error, logFn = console.error) {
  logFn(context, {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
    status: Number.isFinite(error?.status) ? error.status : null,
  });
}

function sendAccountDeletionState(res, deletion) {
  return res.status(410).json({
    code:
      deletion.status === "complete"
        ? "ACCOUNT_DELETED"
        : "ACCOUNT_DELETION_IN_PROGRESS",
    error:
      deletion.status === "complete"
        ? "This account has been deleted."
        : "Account deletion is in progress.",
    ...publicAccountDeletion(deletion),
  });
}

export async function sendAccountDeletionRaceResponse(
  res,
  {
    uid,
    db = null,
    error,
    context = "[account deletion race]",
    getDbFn = getDb,
    logFn = console.error,
  } = {}
) {
  if (!uid) return false;

  try {
    const activeDb = db || (await getDbFn());
    const deletion = await getAccountDeletion(activeDb, uid);
    if (!deletion) return false;
    logErrorMetadata(context, error, logFn);
    sendAccountDeletionState(res, deletion);
    return true;
  } catch (lookupError) {
    logErrorMetadata(`${context} state lookup`, lookupError, logFn);
    return false;
  }
}

export async function requireAuthenticatedUser(
  req,
  res,
  {
    verifySignedTokenFn = verifyFirebaseTokenSignature,
    verifyActiveTokenFn = verifyFirebaseToken,
    getDbFn = getDb,
  } = {}
) {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({
      code: "AUTH_REQUIRED",
      error: "Missing Bearer token",
    });

    return null;
  }

  let signedDecoded;
  try {
    signedDecoded = await verifySignedTokenFn(token);
    if (!signedDecoded?.uid) throw new Error("Token is missing a UID");
  } catch (error) {
    console.error("[requireAuthenticatedUser signature]", {
      name: String(error?.name || "Error"),
      code: error?.code ? String(error.code) : null,
    });

    res.status(401).json({
      code: "AUTH_INVALID",
      error: "Invalid or expired token",
    });

    return null;
  }

  try {
    const db = await getDbFn();
    const deletion = await getAccountDeletion(db, signedDecoded?.uid);
    if (deletion) {
      sendAccountDeletionState(res, deletion);
      return null;
    }
  } catch (error) {
    console.error("[requireAuthenticatedUser deletion guard]", {
      name: String(error?.name || "Error"),
      code: error?.code ? String(error.code) : null,
    });
    res.status(500).json({
      code: "AUTH_STATE_UNAVAILABLE",
      error: "Could not verify the account state.",
    });
    return null;
  }

  try {
    const activeDecoded = await verifyActiveTokenFn(token);
    if (!activeDecoded?.uid || activeDecoded.uid !== signedDecoded.uid) {
      throw new Error("Firebase token verification returned a different UID");
    }
    return activeDecoded;
  } catch (error) {
    console.error("[requireAuthenticatedUser active]", {
      name: String(error?.name || "Error"),
      code: error?.code ? String(error.code) : null,
    });
    res.status(401).json({
      code: "AUTH_INVALID",
      error: "Invalid or expired token",
    });
    return null;
  }
}

async function authenticateRequest(req, res, next) {
  const decoded = await requireAuthenticatedUser(req, res);
  if (!decoded) return;
  req.authenticatedUser = decoded;
  next();
}

function rateLimitAuthenticatedRequest(scope, limit) {
  return async (req, res, next) => {
    const decoded = req.authenticatedUser;
    const result = rateLimitStart(`${scope}:${decoded.uid}`, limit);
    if (result.ok) {
      next();
      return;
    }

    try {
      const db = await getDb();
      const subscription = await getUserSubscription(db, decoded.uid);
      const { plan } = resolveSubscriptionAccess(subscription);
      const quota = await getQuotaSnapshot(
        db,
        "user",
        decoded.uid,
        plan.dailyTokenLimit !== null,
        { dailyLimit: plan.dailyTokenLimit ?? undefined }
      );
      res.status(429).json({
        code: "RATE_LIMITED",
        error: `Too many requests. Try again in ${Math.ceil(
          result.retryAfterMs / 1_000
        )}s.`,
        retryAfterMs: result.retryAfterMs,
        quota: quotaResponse(quota),
      });
    } catch (error) {
      console.error(`[${scope} rate limit]`, error);
      res.status(500).json({
        code: "QUOTA_LOAD_FAILED",
        error: "Could not check the current request allowance.",
      });
    }
  };
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createRecipeRequestAbortScope(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("The recipe recommendation request disconnected."));
    }
  };
  req.once?.("aborted", abort);
  res.once?.("close", abort);

  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener?.("aborted", abort);
      res.removeListener?.("close", abort);
    },
  };
}

export function createRecipeRecommendationHandler({
  recommendRecipesFn = runRecipeRecommendations,
  search = TOOLS.webSearch,
  fetchPage = fetchPublicTextPage,
  sanitizeRecipeContextFn = sanitizeRecipeContext,
  estimateMeta = estimateAndApplyRecipeMetadata,
  estimationEnabled = recipeEstimationEnabled(),
} = {}) {
  if (typeof recommendRecipesFn !== "function") {
    throw new TypeError("recommendRecipesFn must be a function");
  }
  if (typeof search !== "function") {
    throw new TypeError("search must be a function");
  }
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchPage must be a function");
  }
  if (typeof sanitizeRecipeContextFn !== "function") {
    throw new TypeError("sanitizeRecipeContextFn must be a function");
  }
  if (typeof estimateMeta !== "function") {
    throw new TypeError("estimateMeta must be a function");
  }

  return async function recipeRecommendationHandler(req, res) {
    if (!req.authenticatedUser?.uid) {
      return res.status(401).json({
        code: "AUTH_REQUIRED",
        error: "Authentication is required.",
      });
    }

    const body = req.body;
    const overrides = body?.overrides ?? {};
    const recipeContext = body?.recipeContext ?? {};
    if (
      !isPlainRecord(body) ||
      !isPlainRecord(overrides) ||
      !isPlainRecord(recipeContext) ||
      !payloadComplexityIsValid(body)
    ) {
      return res.status(400).json({
        code: "INVALID_RECIPE_REQUEST",
        error: "overrides and recipeContext must be reasonably sized objects.",
      });
    }

    const abortScope = createRecipeRequestAbortScope(req, res);
    try {
      const safeRecipeContext = sanitizeRecipeContextFn(recipeContext);
      const result = await recommendRecipesFn(overrides, safeRecipeContext, {
        search,
        fetchPage,
        signal: abortScope.signal,
        estimateMeta,
        estimationEnabled,
      });
      if (abortScope.signal.aborted || res.headersSent) return;
      return res.json(result);
    } catch (error) {
      if (abortScope.signal.aborted || res.headersSent) return;
      logErrorMetadata("[POST /api/recipes/recommend]", error);
      const timedOut =
        error instanceof RecipeRecommendationError && error.code === "TIMEOUT";
      return res.status(timedOut ? 504 : 500).json({
        code: timedOut
          ? "RECIPE_RECOMMENDATION_TIMEOUT"
          : "RECIPE_RECOMMENDATION_FAILED",
        error: timedOut
          ? "Recipe recommendation timed out."
          : "Could not recommend recipes.",
      });
    } finally {
      abortScope.cleanup();
    }
  };
}

function handleAudioUpload(req, res, next) {
  uploadAudio.single("file")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "Audio recording is too large. Maximum size is 2 MB.",
        });
        return;
      }

      res.status(400).json({
        error: error.message || "Audio upload failed.",
      });
      return;
    }

    res.status(400).json({
      error: error?.message || "Invalid audio upload.",
    });
  });
}

// This endpoint authenticates with an explicit Firebase Bearer token and does
// not use cookies, so browser clients can safely call it from another origin.
export function allowTranscriptionCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

export function attachRoutes(app) {
  app.use(
    express.json({
      limit: "2mb",
    })
  );

  app.get("/live", (_req, res) => {
    res.json({
      ok: true,
      service: "mobilesearcherbackend",
      ts: Date.now(),
    });
  });

  const readinessHandler = async (_req, res) => {
    const readiness = await inspectReadiness();
    return res.status(readiness.status).json({
      ...readiness,
      service: "mobilesearcherbackend",
      ts: Date.now(),
    });
  };
  app.get("/ready", readinessHandler);
  // Preserve the deployment's existing probe URL, but make it truthful.
  app.get("/health", readinessHandler);

  app.post(
    "/api/recipes/recommend",
    authenticateRequest, 
    rateLimitAuthenticatedRequest(
      "recipe-recommendation",
      RECIPE_RECOMMENDATION_RATE_LIMIT
    ),
    limitConcurrentRecipeRecommendations,
    createRecipeRecommendationHandler()
  );

  // --------------------
  // Auth test
  // --------------------
  app.get("/me", async (req, res) => {
    const decoded = await requireAuthenticatedUser(req, res);

    if (!decoded) {
      return;
    }

    return res.json({
      uid: decoded.uid,
      email: decoded.email || null,
    });
  });

  // --------------------
  // Authenticated app bootstrap. Provisioning is idempotent so a completed
  // Firebase sign-in always has matching local server state.
  // --------------------
  app.get("/api/session", async (req, res) => {
    let decoded = null;
    let db = null;
    try {
      decoded = await requireAuthenticatedUser(req, res);
      if (!decoded) return;

      db = await getDb();
      return res.json(await buildSession(db, decoded));
    } catch (error) {
      if (
        await sendAccountDeletionRaceResponse(res, {
          uid: decoded?.uid,
          db,
          error,
          context: "[GET /api/session deletion race]",
        })
      ) {
        return;
      }
      logErrorMetadata("[GET /api/session]", error);
      return res.status(500).json({
        code: "SESSION_LOAD_FAILED",
        error: "Failed to load session",
      });
    }
  });

  // Capture Apple's single-use authorization code while it is fresh. The
  // backend exchanges it, verifies that it belongs to the authenticated
  // Firebase Apple provider, and stores only an encrypted refresh token.
  app.post(
    "/api/auth/apple/link",
    authenticateRequest,
    rateLimitAuthenticatedRequest(
      "apple-auth-link",
      APPLE_AUTH_LINK_RATE_LIMIT
    ),
    async (req, res) => {
      let releaseAccountLock = null;
      let db = null;
      try {
        const decoded = req.authenticatedUser;
        releaseAccountLock = await acquireKeyedLock(decoded.uid);
        const firebaseUser = await getFirebaseUser(decoded.uid);
        db = await getDb();
        await ensureUserProfile(db, decoded);
        await linkAppleAuthorizationForUser(db, {
          decoded,
          authorizationCode: req.body?.authorizationCode,
          getFirebaseUserFn: async () => firebaseUser,
        });
        return res.json({ ok: true, linked: true });
      } catch (error) {
        if (
          await sendAccountDeletionRaceResponse(res, {
            uid: req.authenticatedUser?.uid,
            db,
            error,
            context: "[POST /api/auth/apple/link deletion race]",
          })
        ) {
          return;
        }
        return sendAppleSignInError(
          res,
          error,
          "[POST /api/auth/apple/link]"
        );
      } finally {
        releaseAccountLock?.();
      }
    }
  );

  // --------------------
  // Verify StoreKit 2 JWS evidence for the authenticated Firebase account.
  // New purchases must contain this user's server-generated appAccountToken.
  // --------------------
  app.post(
    "/api/subscriptions/apple/verify",
    authenticateRequest,
    rateLimitAuthenticatedRequest(
      "apple-subscription-verification",
      APPLE_VERIFICATION_RATE_LIMIT
    ),
    limitConcurrentAppleVerifications,
    async (req, res) => {
      let db = null;
      try {
        const decoded = req.authenticatedUser;
        db = await getDb();
        const profile = await ensureUserProfile(db, decoded);
        const result = await verifyAppleEvidenceForUser(db, {
          uid: decoded.uid,
          appAccountToken: profile.apple_app_account_token,
          body: req.body,
        });
        return res.json({
          acceptedTransactionIds: result.acceptedTransactionIds,
          rejected: result.rejected,
          rejectedCount: result.rejectedCount,
          session: await buildSession(db, decoded, { profile }),
        });
      } catch (error) {
        if (
          await sendAccountDeletionRaceResponse(res, {
            uid: req.authenticatedUser?.uid,
            db,
            error,
            context: "[POST /api/subscriptions/apple/verify deletion race]",
          })
        ) {
          return;
        }
        return sendAppleSubscriptionError(
          res,
          error,
          "[POST /api/subscriptions/apple/verify]"
        );
      }
    }
  );

  app.post(
    "/api/subscriptions/apple/refresh",
    authenticateRequest,
    rateLimitAuthenticatedRequest(
      "apple-subscription-refresh",
      APPLE_VERIFICATION_RATE_LIMIT
    ),
    limitConcurrentAppleVerifications,
    async (req, res) => {
      let db = null;
      try {
        const decoded = req.authenticatedUser;
        db = await getDb();
        const profile = await ensureUserProfile(db, decoded);
        await refreshAppleSubscriptionForUser(db, {
          uid: decoded.uid,
          appAccountToken: profile.apple_app_account_token,
        });
        return res.json({ session: await buildSession(db, decoded, { profile }) });
      } catch (error) {
        if (
          await sendAccountDeletionRaceResponse(res, {
            uid: req.authenticatedUser?.uid,
            db,
            error,
            context: "[POST /api/subscriptions/apple/refresh deletion race]",
          })
        ) {
          return;
        }
        return sendAppleSubscriptionError(
          res,
          error,
          "[POST /api/subscriptions/apple/refresh]"
        );
      }
    }
  );

  // App Store Server Notifications V2 authenticates through Apple's signed
  // JWS payload, not a Firebase token.
  app.post(
    "/api/webhooks/apple/app-store-server-notifications-v2",
    limitConcurrentAppleWebhooks,
    async (req, res) => {
      try {
        const db = await getDb();
        const result = await processAppleNotification(
          db,
          req.body?.signedPayload
        );
        return res.json({ ok: true, duplicate: result.duplicate });
      } catch (error) {
        return sendAppleSubscriptionError(
          res,
          error,
          "[POST Apple Notifications V2]"
        );
      }
    }
  );

  // --------------------
  // Create or update user profile
  // POST /api/users
  // Body: { username: string }
  // --------------------
  app.post("/api/users", async (req, res) => {
    let decoded = null;
    let db = null;
    try {
      decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const uid = decoded.uid;

      const username =
        typeof req.body?.username === "string"
          ? req.body.username.trim()
          : "";

      if (!username) {
        return res.status(400).json({
          error: "username is required",
        });
      }

      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({
          error: "username must be 2-20 chars",
        });
      }

      const hasSubscription = hasOwn(req.body || {}, "subscription");
      const normalizedSubscription = hasSubscription
        ? normalizeSubscriptionSnapshot(req.body.subscription)
        : null;

      db = await getDb();

      await db.run(
        `INSERT INTO users (
          uid,
          username,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          ?,
          strftime('%s', 'now'),
          strftime('%s', 'now')
        )
        ON CONFLICT(uid) DO UPDATE SET
          username = excluded.username,
          updated_at = strftime('%s', 'now')`,
        [uid, username]
      );

      const subscription = normalizedSubscription
        ? await saveUserSubscription(db, uid, normalizedSubscription)
        : await getUserSubscription(db, uid);
      const deletion = await getAccountDeletion(db, uid);
      if (deletion) return sendAccountDeletionState(res, deletion);

      return res.json({
        ok: true,
        uid,
        username,
        subscription,
      });
    } catch (error) {
      if (
        await sendAccountDeletionRaceResponse(res, {
          uid: decoded?.uid,
          db,
          error,
          context: "[POST /api/users deletion race]",
        })
      ) {
        return;
      }
      logErrorMetadata("[POST /api/users]", error);

      if (error instanceof SubscriptionStatusValidationError) {
        return res.status(400).json({
          error: error.message,
          field: error.field,
        });
      }

      return res.status(500).json({ error: "Failed to save user" });
    }
  });

  // --------------------
  // Update authenticated user's profile and/or client-reported StoreKit status
  // PATCH /api/users/me
  // Body: { name?: string, username?: string, subscription?: StoreKitSnapshot }
  // --------------------
  app.patch("/api/users/me", async (req, res) => {
    let db = null;
    let decoded = null;
    // let transactionStarted = false;

    try {
      decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const usernameUpdate = getOptionalUsername(req.body);
      const hasSubscription = hasOwn(req.body || {}, "subscription");

      if (!usernameUpdate.provided && !hasSubscription) {
        return res.status(400).json({
          error: "name, username, or subscription is required",
        });
      }

      const normalizedSubscription = hasSubscription
        ? normalizeSubscriptionSnapshot(req.body.subscription)
        : null;

      db = await getDb();

      const existingUser = await db.get(
        `SELECT uid, username
           FROM users
          WHERE uid = ?`,
        [decoded.uid]
      );

      if (!existingUser) {
        const deletion = await getAccountDeletion(db, decoded.uid);
        if (deletion) return sendAccountDeletionState(res, deletion);
        return res.status(404).json({
          error: "User not found",
        });
      }

      // await db.exec("BEGIN TRANSACTION");
      // transactionStarted = true;

      if (usernameUpdate.provided) {
        await db.run(
          `UPDATE users
              SET username = ?,
                  updated_at = strftime('%s', 'now')
            WHERE uid = ?`,
          [usernameUpdate.username, decoded.uid]
        );
      }

      const subscription = normalizedSubscription
        ? await saveUserSubscription(
          db,
          decoded.uid,
          normalizedSubscription
        )
        : await getUserSubscription(db, decoded.uid);

      // await db.exec("COMMIT");
      // transactionStarted = false;

      const deletion = await getAccountDeletion(db, decoded.uid);
      if (deletion) return sendAccountDeletionState(res, deletion);

      return res.json({
        ok: true,
        uid: decoded.uid,
        username: usernameUpdate.provided
          ? usernameUpdate.username
          : existingUser.username,
        subscription,
      });
    } catch (error) {
      // if (transactionStarted && db) {
      //   await db.exec("ROLLBACK").catch(() => {});
      // }

      if (
        await sendAccountDeletionRaceResponse(res, {
          uid: decoded?.uid,
          db,
          error,
          context: "[PATCH /api/users/me deletion race]",
        })
      ) {
        return;
      }
      logErrorMetadata("[PATCH /api/users/me]", error);

      if (error instanceof SubscriptionStatusValidationError) {
        return res.status(400).json({
          error: error.message,
          field: error.field,
        });
      }

      if (error instanceof TypeError || error instanceof RangeError) {
        return res.status(400).json({
          error: error.message,
        });
      }

      return res.status(500).json({ error: "Failed to update user" });
    }
  });

  // --------------------
  // Get authenticated user's profile
  // GET /api/users/:uid
  // --------------------
  app.get("/api/users/:uid", async (req, res) => {
    let decoded = null;
    let db = null;
    try {
      decoded = await requireAuthenticatedUser(req, res);

      if (!decoded) {
        return;
      }

      const requestedUid = String(req.params.uid || "").trim();

      if (!requestedUid) {
        return res.status(400).json({
          error: "uid is required",
        });
      }

      if (requestedUid !== decoded.uid) {
        return res.status(403).json({
          error: "Forbidden",
        });
      }

      const db = await getDb();

      const row = await db.get(
        `SELECT uid, username
         FROM users
         WHERE uid = ?`,
        [requestedUid]
      );

      if (!row) {
        const deletion = await getAccountDeletion(db, requestedUid);
        if (deletion) return sendAccountDeletionState(res, deletion);
        return res.status(404).json({
          error: "User not found",
        });
      }

      const subscription = await getUserSubscription(db, requestedUid);
      const deletion = await getAccountDeletion(db, requestedUid);
      if (deletion) return sendAccountDeletionState(res, deletion);

      return res.json({
        ok: true,
        uid: row.uid,
        username: row.username,
        subscription,
      });
    } catch (error) {
      if (
        await sendAccountDeletionRaceResponse(res, {
          uid: decoded?.uid,
          db,
          error,
          context: "[GET /api/users/:uid deletion race]",
        })
      ) {
        return;
      }
      logErrorMetadata("[GET /api/users/:uid]", error);

      return res.status(500).json({
        error: "Failed to load user",
      });
    }
  });

  // Durable, idempotent deletion and response-loss reconciliation deliberately
  // use a signature-valid token after Firebase removal. These routes enforce
  // their own UID scoping and never provision account data.
  attachAccountDeletionRoutes(app);

  // --------------------
  // Transcribe recorded audio
  // POST /api/transcriptions
  //
  // Authorization:
  //   Bearer <Firebase ID token>
  //
  // multipart/form-data:
  //   file: audio recording
  // --------------------
  app.options("/api/transcriptions", allowTranscriptionCors);
  app.post(
    "/api/transcriptions",
    allowTranscriptionCors,
    authenticateRequest,
    rateLimitAuthenticatedRequest(
      "transcription",
      TRANSCRIPTION_RATE_LIMIT
    ),
    limitConcurrentTranscriptions,
    handleAudioUpload,
    async (req, res) => {
      let quotaReservationContext = null;

      try {
        const decoded = req.authenticatedUser;

        const uploadedFile = req.file;

        if (!uploadedFile) {
          return res.status(400).json({
            error: "No audio file was uploaded.",
          });
        }

        if (!uploadedFile.buffer?.length) {
          return res.status(400).json({
            error: "Uploaded audio file is empty.",
          });
        }

        const db = await getDb();
        const subscription = await getUserSubscription(db, decoded.uid);
        const { plan } = resolveSubscriptionAccess(subscription);
        const dailyLimit = plan.dailyTokenLimit;
        const quotaApplies = dailyLimit !== null;
        let quotaReservation = null;

        if (quotaApplies) {
          const usage = await getUsageRow(db, "user", decoded.uid);
          const remainingTokens = computeRemainingTokens(
            usage.tokens_used,
            dailyLimit
          );
          const quota = createQuotaSnapshot({
            applies: true,
            tokensUsed: usage.tokens_used,
            dailyLimit,
          });
          const estimatedAudioTokens = estimateAudioTokensFromBytes(
            uploadedFile.buffer.length
          );

          if (remainingTokens <= 0) {
            return res.status(429).json({
              code: "QUOTA_EXHAUSTED",
              error:
                "Daily token limit reached. Please try again after the quota resets.",
              quota: quotaResponse(quota),
            });
          }

          if (estimatedAudioTokens > remainingTokens) {
            return res.status(429).json({
              code: "REQUEST_TOO_LARGE",
              error:
                "This recording is too large for the remaining daily token budget.",
              quota: {
                ...quotaResponse(quota),
                estimatedTokens: estimatedAudioTokens,
              },
            });
          }

          // Audio Transcriptions has no request parameter that can cap total
          // tokens, so reserve a conservative file-size bound before calling it.
          /* Previous full-remaining-budget reservation:
          quotaReservation = await reserveUsage(
            db,
            "user",
            decoded.uid,
            remainingTokens,
            NON_SUBSCRIBER_TOKENS_PER_DAY
          );
          */
          quotaReservation = await reserveUsage(
            db,
            "user",
            decoded.uid,
            estimatedAudioTokens,
            dailyLimit
          );

          if (!quotaReservation) {
            const latestUsage = await getUsageRow(db, "user", decoded.uid);
            const latestQuota = createQuotaSnapshot({
              applies: true,
              tokensUsed: latestUsage.tokens_used,
              dailyLimit,
            });
            return res.status(429).json({
              code: "QUOTA_EXHAUSTED",
              error: "The daily token allowance is currently in use.",
              quota: quotaResponse(latestQuota),
            });
          }

          quotaReservationContext = {
            db,
            uid: decoded.uid,
            reservation: quotaReservation,
            dailyLimit,
          };
        }

        const formData = new FormData();

        const audioBlob = new Blob(
          [uploadedFile.buffer],
          {
            type:
              uploadedFile.mimetype ||
              "audio/m4a",
          }
        );

        formData.append(
          "file",
          audioBlob,
          uploadedFile.originalname ||
            "recording.m4a"
        );

        formData.append(
          "model",
          "gpt-4o-mini-transcribe"
        );

        const upstreamController = new AbortController();
        const upstreamTimeout = setTimeout(
          () => upstreamController.abort(),
          OPENAI_REST_TIMEOUT_MS
        );
        let openAIResponse;
        let responseText;

        try {
          openAIResponse = await fetch(
            "https://api.openai.com/v1/audio/transcriptions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
              },
              body: formData,
              signal: upstreamController.signal,
            }
          );
          responseText = await openAIResponse.text();
        } catch (error) {
          if (upstreamController.signal.aborted) {
            const timeoutError = new Error(
              "The transcription service timed out."
            );
            timeoutError.code = "UPSTREAM_TIMEOUT";
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(upstreamTimeout);
        }

        let data;

        try {
          data = JSON.parse(responseText);
        } catch {
          data = {
            error: {
              message:
                responseText ||
                "OpenAI returned an invalid response.",
            },
          };
        }

        if (!openAIResponse.ok) {
          console.error("[POST /api/transcriptions] OpenAI error", {
            status: openAIResponse.status,
          });

          if (quotaReservation) {
            await reconcileUsageReservation(
              db,
              "user",
              decoded.uid,
              quotaReservation,
              0,
              0
            );
            quotaReservationContext = null;
          }

          return res
            .status(openAIResponse.status)
            .json({
              code: "UPSTREAM_ERROR",
              error: "The transcription service failed.",
            });
        }

        /* Previous post-hoc transcription usage write. A full remaining-budget
           reservation now prevents parallel requests from bypassing the limit.
        if (quotaApplies) {
          const usedTokens = Number.isFinite(data?.usage?.total_tokens)
            ? Math.max(0, Math.trunc(data.usage.total_tokens))
            : 0;
          await addUsage(db, "user", decoded.uid, usedTokens, 1);
        }
        */
        let reconciledUsage = null;
        if (quotaReservation) {
          const usedTokens = Number.isFinite(data?.usage?.total_tokens)
            ? Math.max(0, Math.trunc(data.usage.total_tokens))
            : null;
          reconciledUsage = await reconcileUsageReservation(
            db,
            "user",
            decoded.uid,
            quotaReservation,
            usedTokens,
            1
          );
          quotaReservationContext = null;
        }

        const transcript =
          typeof data?.text === "string"
            ? data.text.trim()
            : "";

        if (!transcript) {
          return res.status(422).json({
            error:
              "No speech was detected in the recording.",
          });
        }

        const quota = createQuotaSnapshot({
          applies: quotaApplies,
          tokensUsed: reconciledUsage?.tokens_used || 0,
          dailyLimit: dailyLimit ?? undefined,
        });

        return res.json({
          ok: true,
          text: transcript,
          quota: quotaResponse(quota),
        });
      } catch (error) {
        let quota = null;
        if (quotaReservationContext) {
          const { db, uid, reservation, dailyLimit } = quotaReservationContext;
          await reconcileUsageReservation(
            db,
            "user",
            uid,
            reservation,
            null,
            1
          ).catch(() => {});
          quota = await getQuotaSnapshot(db, "user", uid, true, {
            dailyLimit,
          }).catch(() => null);
        }

        if (
          await sendAccountDeletionRaceResponse(res, {
            uid: req.authenticatedUser?.uid,
            db: quotaReservationContext?.db || null,
            error,
            context: "[POST /api/transcriptions deletion race]",
          })
        ) {
          return;
        }
        logErrorMetadata("[POST /api/transcriptions]", error);

        const upstreamTimedOut = error?.code === "UPSTREAM_TIMEOUT";
        return res
          .status(upstreamTimedOut ? 504 : 500)
          .json({
          ...(upstreamTimedOut ? { code: "UPSTREAM_TIMEOUT" } : {}),
          error: upstreamTimedOut
            ? "The transcription service timed out."
            : "Unable to transcribe the recording.",
          ...(quota ? { quota: quotaResponse(quota) } : {}),
        });
      }
    }
  );

  // --------------------
  // Summarize chat history
  // --------------------
  app.post(
    "/summarize",
    authenticateRequest,
    rateLimitAuthenticatedRequest("summary", SUMMARY_RATE_LIMIT),
    limitConcurrentSummaries,
    async (req, res) => {
    let quotaReservationContext = null;
    let db = null;

    try {
      const decoded = req.authenticatedUser;

      const {
        messages,
        language = "en",
      } = req.body || {};

      if (typeof language !== "string" || language.length > 32) {
        return res.status(400).json({
          code: "INVALID_REQUEST",
          error: "language must be a string of at most 32 characters",
        });
      }

      if (
        !Array.isArray(messages) ||
        messages.length === 0 ||
        messages.length > MAX_CHAT_MESSAGES ||
        !payloadComplexityIsValid(messages)
      ) {
        return res.status(400).json({
          code: "INVALID_REQUEST",
          error: `messages must be a non-empty array of at most ${MAX_CHAT_MESSAGES} reasonably sized items`,
        });
      }

      const summaryQuotaMessages = [
        {
          role: "system",
          content:
            "Summarize the following chat for memory retention. " +
            "Focus only on fridge and shopping-list state. " +
            `Reply in ${language}.`,
        },
        ...messages,
      ];
      db = await getDb();
      const subscription = await getUserSubscription(db, decoded.uid);
      const { plan } = resolveSubscriptionAccess(subscription);
      const dailyLimit = plan.dailyTokenLimit;
      const quotaApplies = dailyLimit !== null;
      let quotaBudget = null;
      let quotaReservation = null;

      const estimatedSummaryPromptTokens =
        estimateTokensFromMessages(summaryQuotaMessages);
      if (estimatedSummaryPromptTokens > plan.maxPromptTokens) {
        return res.status(413).json({
          code: "REQUEST_TOO_LARGE",
          error: "This conversation is too large to summarize.",
        });
      }

      if (quotaApplies) {
        const usage = await getUsageRow(db, "user", decoded.uid);
        const quota = createQuotaSnapshot({
          applies: true,
          tokensUsed: usage.tokens_used,
          dailyLimit,
        });
        quotaBudget = computeTokenBudget({
          tokensUsed: usage.tokens_used,
          dailyLimit,
          maxCompletionTokens: plan.maxCompletionTokens,
          estPromptTokens: estimatedSummaryPromptTokens,
        });

        if (!quotaBudget.ok) {
          return res.status(429).json({
            code:
              quotaBudget.remainingTokens === 0
                ? "QUOTA_EXHAUSTED"
                : "REQUEST_TOO_LARGE",
            error: quotaBudget.reason,
            quota: quotaResponse(quota),
          });
        }

        quotaReservation = await reserveUsage(
          db,
          "user",
          decoded.uid,
          quotaBudget.estPromptTokens + quotaBudget.maxCompletionTokens,
          dailyLimit
        );

        if (!quotaReservation) {
          const latestUsage = await getUsageRow(db, "user", decoded.uid);
          const latestQuota = createQuotaSnapshot({
            applies: true,
            tokensUsed: latestUsage.tokens_used,
            dailyLimit,
          });
          return res.status(429).json({
            code: "QUOTA_EXHAUSTED",
            error: "Not enough daily token budget remains for this request.",
            quota: quotaResponse(latestQuota),
          });
        }

        quotaReservationContext = {
          db,
          uid: decoded.uid,
          reservation: quotaReservation,
          dailyLimit,
        };
      }

      const upstreamController = new AbortController();
      const upstreamTimeout = setTimeout(
        () => upstreamController.abort(),
        OPENAI_REST_TIMEOUT_MS
      );
      let openAIResponse;
      let responseText;

      try {
        openAIResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "Summarize the following chat for memory retention. " +
                    "Focus only on fridge and shopping-list state. " +
                    `Reply in ${language}.`,
                },
                ...messages,
              ],
              temperature: 0.2,
              max_completion_tokens:
                quotaBudget?.maxCompletionTokens ||
                plan.maxCompletionTokens,
            }),
            signal: upstreamController.signal,
          }
        );
        responseText = await openAIResponse.text();
      } catch (error) {
        if (upstreamController.signal.aborted) {
          const timeoutError = new Error("The summary service timed out.");
          timeoutError.code = "UPSTREAM_TIMEOUT";
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(upstreamTimeout);
      }

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      if (!openAIResponse.ok) {
        console.error("[POST /summarize] OpenAI error", {
          status: openAIResponse.status,
        });

        if (quotaReservation) {
          await reconcileUsageReservation(
            db,
            "user",
            decoded.uid,
            quotaReservation,
            0,
            0
          );
          quotaReservationContext = null;
        }

        return res
          .status(openAIResponse.status)
          .json({
            code: "UPSTREAM_ERROR",
            error: "Failed to summarize",
          });
      }

      /* Previous post-hoc usage write. Quota-limited calls now reserve before
         making the provider request so parallel calls cannot bypass the check.
      if (quotaApplies) {
        const usedTokens = Number.isFinite(data?.usage?.total_tokens)
          ? Math.max(0, Math.trunc(data.usage.total_tokens))
          : 0;
        await addUsage(db, "user", decoded.uid, usedTokens, 1);
      }
      */
      let reconciledUsage = null;
      if (quotaReservation) {
        const usedTokens = Number.isFinite(data?.usage?.total_tokens)
          ? Math.max(0, Math.trunc(data.usage.total_tokens))
          : null;
        reconciledUsage = await reconcileUsageReservation(
          db,
          "user",
          decoded.uid,
          quotaReservation,
          usedTokens,
          1
        );
        quotaReservationContext = null;
      }

      const summary =
        data?.choices?.[0]?.message?.content ?? "";
      const quota = createQuotaSnapshot({
        applies: quotaApplies,
        tokensUsed: reconciledUsage?.tokens_used || 0,
        dailyLimit: dailyLimit ?? undefined,
      });

      return res.json({
        summary,
        quota: quotaResponse(quota),
      });
    } catch (error) {
      let quota = null;
      if (quotaReservationContext) {
        const { db, uid, reservation, dailyLimit } = quotaReservationContext;
        await reconcileUsageReservation(
          db,
          "user",
          uid,
          reservation,
          null,
          1
        ).catch(() => {});
        quota = await getQuotaSnapshot(db, "user", uid, true, {
          dailyLimit,
        }).catch(() => null);
      }

      if (
        await sendAccountDeletionRaceResponse(res, {
          uid: req.authenticatedUser?.uid,
          db: quotaReservationContext?.db || null,
          error,
          context: "[POST /summarize deletion race]",
        })
      ) {
        return;
      }
      logErrorMetadata("[POST /summarize]", error);

      return res
        .status(error?.code === "UPSTREAM_TIMEOUT" ? 504 : 500)
        .json({
          ...(error?.code ? { code: error.code } : {}),
          error:
            error?.code === "UPSTREAM_TIMEOUT"
              ? error.message
              : "Failed to summarize",
          ...(quota ? { quota: quotaResponse(quota) } : {}),
        });
    }
    }
  );
}

function sendAppleSignInError(res, error, logContext) {
  console.error(logContext, {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
    status: Number.isFinite(error?.status) ? error.status : null,
    retryable: error?.retryable === true,
  });
  if (error instanceof AppleSignInError) {
    return res.status(error.status).json({
      code: error.code,
      error: error.message,
      retryable: error.retryable,
    });
  }
  if (error?.code === "APPLE_SIGN_IN_NOT_CONFIGURED") {
    return res.status(503).json({
      code: error.code,
      error: "Sign in with Apple revocation is not configured.",
      retryable: false,
    });
  }
  return res.status(500).json({
    code: "APPLE_SIGN_IN_ERROR",
    error: "Sign in with Apple credential processing failed.",
    retryable: false,
  });
}

function sendAppleSubscriptionError(res, error, logContext) {
  logErrorMetadata(logContext, error);
  if (error instanceof AppleSubscriptionOwnershipError) {
    return res.status(409).json({ code: error.code, error: error.message });
  }
  if (error instanceof AppleSubscriptionError) {
    return res.status(error.status).json({
      code: error.code,
      error: error.message,
      ...(error.details?.rejected
        ? {
            rejected: error.details.rejected,
            rejectedCount: error.details.rejectedCount,
          }
        : {}),
    });
  }
  if (error?.code === "APPLE_NOT_CONFIGURED") {
    return res.status(503).json({
      code: error.code,
      error: "Apple subscription verification is not configured.",
    });
  }
  return res.status(500).json({
    code: "APPLE_SUBSCRIPTION_ERROR",
    error: "Apple subscription verification failed.",
  });
}

function payloadComplexityIsValid(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (
      nodes > MAX_CHAT_PAYLOAD_NODES ||
      current.depth > MAX_CHAT_PAYLOAD_DEPTH
    ) {
      return false;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }

  return true;
}

function quotaResponse(quota) {
  return { ...quota, ...quotaLegacyFields(quota) };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getOptionalUsername(body) {
  const source = body && typeof body === "object" ? body : {};
  const provided = hasOwn(source, "username") || hasOwn(source, "name");

  if (!provided) {
    return { provided: false, username: null };
  }

  const rawUsername = hasOwn(source, "username")
    ? source.username
    : source.name;
  const username =
    typeof rawUsername === "string" ? rawUsername.trim() : "";

  if (!username) {
    throw new TypeError("username is required");
  }

  if (username.length < 2 || username.length > 20) {
    throw new RangeError("username must be 2-20 chars");
  }

  return { provided: true, username };
}
