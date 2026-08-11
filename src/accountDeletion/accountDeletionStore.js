const PUBLIC_STATUSES = new Set(["processing", "complete"]);
const DELETION_COLUMNS = `
  firebase_uid, status, firebase_status, local_data_status,
  apple_identity_linked, apple_revocation_status, apple_subject,
  apple_client_id, encrypted_apple_refresh_token,
  apple_revocation_attempts, apple_next_retry_at,
  firebase_deletion_attempts, firebase_next_retry_at, requested_at,
  updated_at, completed_at, last_error_code, last_error_message
`;

function normalizeUid(uid) {
  const normalized = String(uid || "").trim();
  if (!normalized) throw new TypeError("A Firebase UID is required");
  return normalized;
}

function safeErrorText(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 500) : null;
}

export class AccountDeletionBlockedError extends Error {
  constructor(deletion) {
    const complete = deletion?.status === "complete";
    super(
      complete
        ? "This account has been deleted."
        : "Account deletion is already in progress."
    );
    this.name = "AccountDeletionBlockedError";
    this.code = complete
      ? "ACCOUNT_DELETED"
      : "ACCOUNT_DELETION_IN_PROGRESS";
    this.status = 410;
    // Never attach the tombstone row to an Error. Pending rows can contain the
    // encrypted Apple refresh credential, and Error objects are routinely
    // inspected by application loggers.
    this.deletionStatus = complete ? "complete" : "processing";
  }
}

export async function getAccountDeletion(db, uid) {
  const normalizedUid = normalizeUid(uid);
  return db.get(
    `SELECT ${DELETION_COLUMNS}
       FROM account_deletions
      WHERE firebase_uid = ?`,
    [normalizedUid]
  );
}

export async function listProcessingAccountDeletions(
  db,
  { limit = 25, nowMs = Date.now() } = {}
) {
  const normalizedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, 100)
    : 25;
  return db.all(
    `SELECT firebase_uid
       FROM account_deletions
      WHERE status = 'processing'
        AND (
          (firebase_status <> 'deleted' AND (
            firebase_next_retry_at IS NULL OR firebase_next_retry_at <= ?
          ))
          OR local_data_status <> 'deleted'
          OR (apple_revocation_status = 'pending' AND (
            apple_next_retry_at IS NULL OR apple_next_retry_at <= ?
          ))
          OR (
            firebase_status = 'deleted'
            AND local_data_status = 'deleted'
            AND apple_revocation_status <> 'pending'
          )
        )
      ORDER BY updated_at ASC
      LIMIT ?`,
    [nowMs, nowMs, normalizedLimit]
  );
}

export async function createAccountDeletion(
  db,
  { uid, appleIdentityLinked = false, nowMs = Date.now() }
) {
  const normalizedUid = normalizeUid(uid);
  const existing = await getAccountDeletion(db, normalizedUid);
  if (existing) return existing;

  const created = await db.get(
    `WITH credential AS (
       SELECT apple_subject, client_id, encrypted_refresh_token
         FROM apple_sign_in_credentials
        WHERE firebase_uid = ?
     )
     INSERT OR IGNORE INTO account_deletions (
       firebase_uid, status, firebase_status, local_data_status,
       apple_identity_linked, apple_revocation_status, apple_subject,
       apple_client_id, encrypted_apple_refresh_token,
       apple_revocation_attempts, apple_next_retry_at,
       firebase_deletion_attempts, firebase_next_retry_at, requested_at,
       updated_at, completed_at, last_error_code, last_error_message
     )
     SELECT ?, 'processing', 'pending', 'pending', ?,
            CASE
              WHEN credential.apple_subject IS NOT NULL THEN 'pending'
              WHEN ? = 1 THEN 'manual_required'
              ELSE 'not_linked'
            END,
            credential.apple_subject, credential.client_id,
            credential.encrypted_refresh_token,
            0, NULL, 0, NULL, ?, ?, NULL, NULL, NULL
       FROM (SELECT 1) AS singleton
       LEFT JOIN credential ON 1 = 1
     RETURNING ${DELETION_COLUMNS}`,
    [
      normalizedUid,
      normalizedUid,
      appleIdentityLinked ? 1 : 0,
      appleIdentityLinked ? 1 : 0,
      nowMs,
      nowMs,
    ]
  );

  return created || getAccountDeletion(db, normalizedUid);
}

export async function markAppleRevocationOutcome(
  db,
  uid,
  outcome,
  {
    nowMs = Date.now(),
    error = null,
    incrementAttempts = false,
  } = {}
) {
  if (!["revoked", "manual_required", "not_linked"].includes(outcome)) {
    throw new TypeError("Invalid Apple revocation outcome");
  }

  return db.get(
    `UPDATE account_deletions
        SET apple_revocation_status = ?,
            apple_subject = NULL,
            apple_client_id = NULL,
            encrypted_apple_refresh_token = NULL,
            apple_revocation_attempts =
              apple_revocation_attempts + ?,
            apple_next_retry_at = NULL,
            updated_at = ?,
            last_error_code = ?,
            last_error_message = ?
      WHERE firebase_uid = ?
      RETURNING ${DELETION_COLUMNS}`,
    [
      outcome,
      incrementAttempts ? 1 : 0,
      nowMs,
      safeErrorText(error?.code),
      safeErrorText(error?.message),
      normalizeUid(uid),
    ]
  );
}

export async function recordAppleRevocationRetry(
  db,
  uid,
  error,
  { nowMs = Date.now(), nextRetryAt }
) {
  return db.get(
    `UPDATE account_deletions
        SET apple_revocation_attempts = apple_revocation_attempts + 1,
            apple_next_retry_at = ?, updated_at = ?,
            last_error_code = ?, last_error_message = ?
      WHERE firebase_uid = ? AND apple_revocation_status = 'pending'
      RETURNING ${DELETION_COLUMNS}`,
    [
      nextRetryAt,
      nowMs,
      safeErrorText(error?.code || error?.name),
      safeErrorText(error?.message || error),
      normalizeUid(uid),
    ]
  );
}

export async function markFirebaseDeleted(db, uid, { nowMs = Date.now() } = {}) {
  return db.get(
    `UPDATE account_deletions
        SET firebase_status = 'deleted', firebase_next_retry_at = NULL,
            updated_at = ?,
            last_error_code = NULL, last_error_message = NULL
      WHERE firebase_uid = ?
      RETURNING ${DELETION_COLUMNS}`,
    [nowMs, normalizeUid(uid)]
  );
}

export async function recordFirebaseDeletionRetry(
  db,
  uid,
  error,
  { nowMs = Date.now(), nextRetryAt }
) {
  return db.get(
    `UPDATE account_deletions
        SET firebase_deletion_attempts = firebase_deletion_attempts + 1,
            firebase_next_retry_at = ?, updated_at = ?,
            last_error_code = ?, last_error_message = ?
      WHERE firebase_uid = ? AND firebase_status = 'pending'
      RETURNING ${DELETION_COLUMNS}`,
    [
      nextRetryAt,
      nowMs,
      safeErrorText(error?.code || error?.name),
      safeErrorText(error?.message || error),
      normalizeUid(uid),
    ]
  );
}

export async function markLocalDataDeleted(db, uid, { nowMs = Date.now() } = {}) {
  return db.get(
    `UPDATE account_deletions
        SET local_data_status = 'deleted', updated_at = ?,
            last_error_code = NULL, last_error_message = NULL
      WHERE firebase_uid = ?
      RETURNING ${DELETION_COLUMNS}`,
    [nowMs, normalizeUid(uid)]
  );
}

export async function recordAccountDeletionError(
  db,
  uid,
  error,
  { nowMs = Date.now() } = {}
) {
  return db.get(
    `UPDATE account_deletions
        SET updated_at = ?, last_error_code = ?, last_error_message = ?
      WHERE firebase_uid = ?
      RETURNING ${DELETION_COLUMNS}`,
    [
      nowMs,
      safeErrorText(error?.code || error?.name),
      safeErrorText(error?.message || error),
      normalizeUid(uid),
    ]
  );
}

export async function finalizeAccountDeletion(db, uid, { nowMs = Date.now() } = {}) {
  const normalizedUid = normalizeUid(uid);
  const completed = await db.get(
    `UPDATE account_deletions
        SET status = 'complete', completed_at = COALESCE(completed_at, ?),
            updated_at = ?, last_error_code = NULL, last_error_message = NULL
      WHERE firebase_uid = ?
        AND firebase_status = 'deleted'
        AND local_data_status = 'deleted'
        AND apple_revocation_status IN ('revoked', 'manual_required', 'not_linked')
      RETURNING ${DELETION_COLUMNS}`,
    [nowMs, nowMs, normalizedUid]
  );
  return completed || getAccountDeletion(db, normalizedUid);
}

function isoOrNull(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? new Date(Number(value)).toISOString()
    : null;
}

export function publicAccountDeletion(row) {
  if (!row || !PUBLIC_STATUSES.has(row.status)) return null;
  const complete = row.status === "complete";
  return {
    ok: complete,
    uid: row.firebase_uid,
    deletionStatus: row.status,
    firebaseStatus: row.firebase_status,
    localDataStatus: row.local_data_status,
    appleSignInRevocation: row.apple_revocation_status,
    appleRetryAt: isoOrNull(row.apple_next_retry_at),
    retryable: !complete,
    requestedAt: isoOrNull(row.requested_at),
    updatedAt: isoOrNull(row.updated_at),
    completedAt: isoOrNull(row.completed_at),
  };
}

export function publicAccountNotRequested(uid) {
  return {
    ok: true,
    uid: normalizeUid(uid),
    deletionStatus: "not_requested",
    firebaseStatus: "active",
    localDataStatus: "present",
    appleSignInRevocation: "not_requested",
    appleRetryAt: null,
    retryable: false,
    requestedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}
