import { deleteFirebaseUser } from "../auth/firebase.js";
import { revokeAppleAuthorizationCredential } from "../auth/appleSignInService.js";
import { acquireKeyedLock } from "../utils/keyedLock.js";
import { createAsyncConcurrencyLimit } from "../utils/asyncConcurrencyLimit.js";
import {
  createAccountDeletion,
  finalizeAccountDeletion,
  getAccountDeletion,
  listProcessingAccountDeletions,
  markAppleRevocationOutcome,
  markFirebaseDeleted,
  markLocalDataDeleted,
  publicAccountDeletion,
  recordAppleRevocationRetry,
  recordAccountDeletionError,
  recordFirebaseDeletionRetry,
} from "./accountDeletionStore.js";

export const ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;
const APPLE_REVOCATION_MAX_ATTEMPTS = 5;
const APPLE_REVOCATION_RETRY_BASE_MS = 60_000;
const APPLE_REVOCATION_RETRY_MAX_MS = 60 * 60_000;
const FIREBASE_DELETION_RETRY_BASE_MS = 5_000;
const FIREBASE_DELETION_RETRY_MAX_MS = 5 * 60_000;
const runFirebaseDeletion = createAsyncConcurrencyLimit(4);

export class AccountDeletionError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "AccountDeletionError";
    this.code = code;
    this.status = status;
    this.details = details || null;
  }
}

export function assertRecentAccountAuthentication(
  decoded,
  {
    nowSeconds = Math.floor(Date.now() / 1_000),
    maxAgeSeconds = ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS,
  } = {}
) {
  const authTime = Number(decoded?.auth_time);
  if (
    !Number.isFinite(authTime) ||
    authTime > nowSeconds + CLOCK_SKEW_SECONDS ||
    nowSeconds - authTime > maxAgeSeconds
  ) {
    throw new AccountDeletionError(
      "RECENT_AUTH_REQUIRED",
      "Sign in again before deleting your account.",
      {
        status: 403,
        details: { maxAgeSeconds },
      }
    );
  }
}

function isFirebaseUserNotFound(error) {
  return error?.code === "auth/user-not-found";
}

function appleCredentialFromDeletion(deletion) {
  if (
    !deletion?.apple_subject ||
    !deletion?.apple_client_id ||
    !deletion?.encrypted_apple_refresh_token
  ) {
    return null;
  }

  return {
    apple_subject: deletion.apple_subject,
    client_id: deletion.apple_client_id,
    encrypted_refresh_token: deletion.encrypted_apple_refresh_token,
  };
}

async function advanceAppleRevocation(
  db,
  deletion,
  { revokeAppleCredentialFn, nowFn }
) {
  if (deletion.apple_revocation_status !== "pending") return deletion;

  const nowMs = nowFn();
  if (
    Number.isFinite(Number(deletion.apple_next_retry_at)) &&
    Number(deletion.apple_next_retry_at) > nowMs
  ) {
    return deletion;
  }

  const credential = appleCredentialFromDeletion(deletion);
  if (!credential) {
    return markAppleRevocationOutcome(
      db,
      deletion.firebase_uid,
      deletion.apple_identity_linked ? "manual_required" : "not_linked",
      { nowMs }
    );
  }

  try {
    await revokeAppleCredentialFn({
      uid: deletion.firebase_uid,
      credential,
    });
    deletion = await markAppleRevocationOutcome(
      db,
      deletion.firebase_uid,
      "revoked",
      { nowMs, incrementAttempts: true }
    );
  } catch (error) {
    // Account deletion never depends on Apple availability. Retry explicitly
    // retryable failures from the tombstone after the user row is gone; bound
    // the retry loop so a permanently unavailable service eventually becomes
    // a durable manual action for the client.
    console.error("[account deletion Apple revocation fallback]", {
      name: String(error?.name || "Error"),
      code: error?.code ? String(error.code) : null,
      retryable: error?.retryable === true,
    });
    const nextAttempt = Number(deletion.apple_revocation_attempts || 0) + 1;
    if (error?.retryable === true && nextAttempt < APPLE_REVOCATION_MAX_ATTEMPTS) {
      const delayMs = Math.min(
        APPLE_REVOCATION_RETRY_MAX_MS,
        APPLE_REVOCATION_RETRY_BASE_MS * 2 ** (nextAttempt - 1)
      );
      deletion = await recordAppleRevocationRetry(db, deletion.firebase_uid, error, {
        nowMs,
        nextRetryAt: nowMs + delayMs,
      });
    } else {
      deletion = await markAppleRevocationOutcome(
        db,
        deletion.firebase_uid,
        "manual_required",
        { nowMs, error, incrementAttempts: true }
      );
    }
  }

  return deletion;
}

async function advanceFirebaseDeletion(
  db,
  deletion,
  { deleteFirebaseUserFn, nowFn }
) {
  if (deletion.firebase_status === "deleted") return deletion;
  const dueCheckNowMs = nowFn();
  if (
    Number.isFinite(Number(deletion.firebase_next_retry_at)) &&
    Number(deletion.firebase_next_retry_at) > dueCheckNowMs
  ) {
    return deletion;
  }

  try {
    await runFirebaseDeletion(() => deleteFirebaseUserFn(deletion.firebase_uid));
    return markFirebaseDeleted(db, deletion.firebase_uid, { nowMs: nowFn() });
  } catch (error) {
    // The limiter wait and Firebase request can take longer than the first
    // backoff interval. Base retry timing on completion, not attempt start, so
    // a timeout cannot make the stored retry immediately due.
    const failureNowMs = nowFn();
    if (isFirebaseUserNotFound(error)) {
      return markFirebaseDeleted(db, deletion.firebase_uid, {
        nowMs: failureNowMs,
      });
    }
    const nextAttempt = Number(deletion.firebase_deletion_attempts || 0) + 1;
    const delayMs = Math.min(
      FIREBASE_DELETION_RETRY_MAX_MS,
      FIREBASE_DELETION_RETRY_BASE_MS * 2 ** Math.min(nextAttempt - 1, 16)
    );
    return recordFirebaseDeletionRetry(db, deletion.firebase_uid, error, {
      nowMs: failureNowMs,
      nextRetryAt: failureNowMs + delayMs,
    });
  }
}

async function purgeLocalAccountData(db, deletion, { nowFn }) {
  if (deletion.local_data_status === "deleted") return deletion;
  const uid = deletion.firebase_uid;

  try {
    // Every operation is idempotent and autocommitted. Avoid holding a SQLite
    // transaction across yields or remote calls; a crash simply leaves this
    // tombstone pending and the next worker pass repeats the remaining deletes.
    await db.run(
      `DELETE FROM usage_daily
        WHERE owner_type = 'user' AND owner_key = ?`,
      [uid]
    );
    await db.run(
      `DELETE FROM conversations
        WHERE owner_type = 'user' AND owner_key = ?`,
      [uid]
    );
    await db.run(
      `DELETE FROM recipe_history
        WHERE owner_type = 'user' AND owner_key = ?`,
      [uid]
    );
    await db.run("DELETE FROM users WHERE uid = ?", [uid]);
    return markLocalDataDeleted(db, uid, { nowMs: nowFn() });
  } catch (error) {
    return recordAccountDeletionError(db, uid, error, { nowMs: nowFn() });
  }
}

async function advanceAccountDeletionLocked(
  db,
  uid,
  {
    deleteFirebaseUserFn = deleteFirebaseUser,
    revokeAppleCredentialFn = revokeAppleAuthorizationCredential,
    nowFn = Date.now,
    initialDeletion = null,
  } = {}
) {
  let deletion = initialDeletion || await getAccountDeletion(db, uid);
  if (!deletion || deletion.status === "complete") {
    return deletion;
  }

  deletion = await advanceAppleRevocation(db, deletion, {
    revokeAppleCredentialFn,
    nowFn,
  });
  deletion = await advanceFirebaseDeletion(db, deletion, {
    deleteFirebaseUserFn,
    nowFn,
  });
  deletion = await purgeLocalAccountData(db, deletion, { nowFn });
  return finalizeAccountDeletion(db, uid, { nowMs: nowFn() });
}

export async function requestAccountDeletion(
  db,
  {
    uid,
    appleIdentityLinked = false,
    deleteFirebaseUserFn = deleteFirebaseUser,
    revokeAppleCredentialFn = revokeAppleAuthorizationCredential,
    nowFn = Date.now,
  }
) {
  const release = await acquireKeyedLock(uid);
  try {
    let deletion = await getAccountDeletion(db, uid);
    if (!deletion) {
      deletion = await createAccountDeletion(db, {
        uid,
        appleIdentityLinked,
        nowMs: nowFn(),
      });
    }
    if (deletion.status !== "complete") {
      deletion = await advanceAccountDeletionLocked(db, uid, {
        deleteFirebaseUserFn,
        revokeAppleCredentialFn,
        nowFn,
        initialDeletion: deletion,
      });
    }
    return publicAccountDeletion(deletion);
  } finally {
    release();
  }
}

export async function resumeAccountDeletion(
  db,
  {
    uid,
    deleteFirebaseUserFn = deleteFirebaseUser,
    revokeAppleCredentialFn = revokeAppleAuthorizationCredential,
    nowFn = Date.now,
  }
) {
  const release = await acquireKeyedLock(uid);
  try {
    const deletion = await advanceAccountDeletionLocked(db, uid, {
      deleteFirebaseUserFn,
      revokeAppleCredentialFn,
      nowFn,
    });
    return publicAccountDeletion(deletion);
  } finally {
    release();
  }
}

export async function resumePendingAccountDeletions(
  db,
  { batchSize = 25, concurrency = 4, ...dependencies } = {}
) {
  const nowFn = dependencies.nowFn || Date.now;
  const pending = await listProcessingAccountDeletions(db, {
    limit: batchSize,
    nowMs: nowFn(),
  });
  const results = new Array(pending.length);
  const workerCount = Math.min(
    pending.length,
    Number.isInteger(concurrency) && concurrency > 0
      ? Math.min(concurrency, 8)
      : 4
  );
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pending.length) {
      const index = nextIndex;
      nextIndex += 1;
      const row = pending[index];
      try {
        results[index] = await resumeAccountDeletion(db, {
          uid: row.firebase_uid,
          ...dependencies,
        });
      } catch (error) {
        console.error("[account deletion recovery]", {
          uid: row.firebase_uid,
          name: String(error?.name || "Error"),
          code: error?.code ? String(error.code) : null,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter(Boolean);
}
