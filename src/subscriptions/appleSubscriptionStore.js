import { getAllowedAppleEnvironments } from "./appleConfig.js";
import { acquireKeyedLock } from "../utils/keyedLock.js";
import {
  getPlanByProductId,
  getPlanCatalogPriority,
} from "./planCatalog.js";

const STATUS_NAMES = Object.freeze({
  1: "subscribed",
  2: "expired",
  3: "in_billing_retry_period",
  4: "in_grace_period",
  5: "revoked",
});

export class AppleSubscriptionOwnershipError extends Error {
  constructor() {
    super("This App Store subscription is already linked to another account.");
    this.name = "AppleSubscriptionOwnershipError";
    this.code = "APPLE_PURCHASE_ACCOUNT_CONFLICT";
  }
}

function toIso(value) {
  return Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

export function appleSubscriptionRowToPublic(row, { nowMs = Date.now() } = {}) {
  if (!row) return null;
  const plan = getPlanByProductId(row.product_id);
  const status = STATUS_NAMES[row.status] || "unknown";
  const accessUntil =
    row.status === 4
      ? row.grace_expires_at || row.expires_at
      : row.expires_at;
  const isSubscribed =
    Boolean(plan) &&
    (row.status === 1 || row.status === 4) &&
    Number.isFinite(accessUntil) &&
    accessUntil > nowMs &&
    !row.revoked_at;

  return {
    source: "apple_server",
    verified: true,
    status,
    isEntitled: isSubscribed,
    isSubscribed,
    planId: plan?.id || null,
    productId: row.product_id || null,
    expirationDate: toIso(row.expires_at),
    checkedAt: toIso(row.verified_at),
    willAutoRenew: row.auto_renew_status === 1,
    isPartial: false,
    environment: row.environment,
    originalTransactionId: row.original_transaction_id,
    transactionId: row.latest_transaction_id,
  };
}

export async function getVerifiedAppleSubscription(db, uid) {
  const environments = getAllowedAppleEnvironments();
  const placeholders = environments.map(() => "?").join(", ");
  const rows = await db.all(
    `SELECT *
       FROM apple_subscriptions
      WHERE firebase_uid = ?
        AND environment IN (${placeholders})
      ORDER BY
        CASE WHEN status IN (1, 4) THEN 0 ELSE 1 END,
        verified_at DESC`,
    [uid, ...environments]
  );
  const nowMs = Date.now();
  const candidates = rows
    .map((row) => appleSubscriptionRowToPublic(row, { nowMs }));
  const active = candidates
    .filter((candidate) => candidate.isSubscribed)
    .sort((left, right) => {
      const planDifference =
        getPlanCatalogPriority(left.planId) -
        getPlanCatalogPriority(right.planId);
      if (planDifference) return planDifference;
      if (left.environment !== right.environment) {
        return left.environment === "Production" ? -1 : 1;
      }
      return Date.parse(right.checkedAt || 0) - Date.parse(left.checkedAt || 0);
    });
  return active[0] || candidates[0] || null;
}

export async function getAppleSubscriptionRefreshTarget(db, uid) {
  const environments = getAllowedAppleEnvironments();
  const placeholders = environments.map(() => "?").join(", ");
  return db.get(
    `SELECT environment, latest_transaction_id, original_transaction_id
       FROM apple_subscriptions
      WHERE firebase_uid = ?
        AND environment IN (${placeholders})
      ORDER BY verified_at DESC
      LIMIT 1`,
    [uid, ...environments]
  );
}

/**
 * Every chain the account owns. An account can hold more than one (an adopted
 * chain plus a later purchase), and each needs its own status re-query, so
 * refresh must not stop at the newest row.
 */
export async function getAppleSubscriptionRefreshTargets(db, uid) {
  const environments = getAllowedAppleEnvironments();
  const placeholders = environments.map(() => "?").join(", ");
  return db.all(
    `SELECT environment, latest_transaction_id, original_transaction_id
       FROM apple_subscriptions
      WHERE firebase_uid = ?
        AND environment IN (${placeholders})
      ORDER BY verified_at DESC`,
    [uid, ...environments]
  );
}

/**
 * Resolve a store notification to an account by chain first. After adoption the
 * chain's token belongs to the deleted account while the subscription row
 * belongs to the new one, so a token-only lookup would drop every renewal and
 * refund. Callers fall back to findUserByAppleAccountToken() for the first
 * SUBSCRIBED notification, which can arrive before any row exists.
 */
export async function findUserByAppleChain(
  db,
  { environment, originalTransactionId }
) {
  return db.get(
    `SELECT firebase_uid AS uid
       FROM apple_subscriptions
      WHERE environment = ?
        AND original_transaction_id = ?
      LIMIT 1`,
    [environment, originalTransactionId]
  );
}

/**
 * Ops-only release path, used by scripts/apple-ownership-maintenance.mjs.
 * The normal release signal is the cascade from deleting the users row, so this
 * exists only for manual tombstone removal.
 */
export async function releaseAppleOwnershipForUser(db, uid) {
  const result = await db.run(
    `DELETE FROM apple_subscription_ownership
      WHERE (environment, original_transaction_id) IN (
        SELECT environment, original_transaction_id
          FROM apple_subscriptions
         WHERE firebase_uid = ?
      )`,
    [uid]
  );
  return { released: Number(result?.changes || 0) };
}

export async function findUserByAppleAccountToken(db, appAccountToken) {
  const normalizedToken = String(appAccountToken || "").trim().toLowerCase();
  if (!normalizedToken) return null;
  return db.get(
    `SELECT uid, apple_app_account_token
       FROM users
      WHERE lower(apple_app_account_token) = ?`,
    [normalizedToken]
  );
}

async function readOwnershipState(
  db,
  { environment, originalTransactionId, transactionId = null }
) {
  return db.get(
    `SELECT
       (SELECT firebase_uid
          FROM apple_subscriptions
         WHERE environment = ? AND original_transaction_id = ?)
         AS subscription_uid,
       (SELECT app_account_token
          FROM apple_subscription_ownership
         WHERE environment = ? AND original_transaction_id = ?)
         AS ownership_token,
       (SELECT firebase_uid
          FROM apple_transactions
         WHERE environment = ? AND transaction_id = ?)
         AS transaction_uid`,
    [
      environment,
      originalTransactionId,
      environment,
      originalTransactionId,
      environment,
      transactionId,
    ]
  );
}

async function readAppleOwnershipState(db, record) {
  return readOwnershipState(db, {
    environment: record.environment,
    originalTransactionId: record.originalTransactionId,
    transactionId: record.transactionId,
  });
}

/**
 * Chain state used to resolve a claim before any write: who owns the chain now,
 * and which token originally claimed it (provenance, never a gate).
 */
export async function getAppleChainClaimState(
  db,
  { environment, originalTransactionId }
) {
  const state = await readOwnershipState(db, {
    environment,
    originalTransactionId,
  });
  return {
    ownerUid: state?.subscription_uid ?? null,
    ownershipToken: state?.ownership_token ?? null,
    transactionUid: state?.transaction_uid ?? null,
  };
}

/**
 * The claim rules from docs/apple-subscription-claim-redesign.md section 3.
 * Pure so it can be unit tested without a database, and so the accept/reject
 * decision lives in exactly one place.
 *
 * - `owner`       the chain already belongs to this account; accept regardless
 *                 of the token carried by the transaction (renewals keep the
 *                 original purchase's token, which may predate this account).
 * - `conflict`    a live account owns the chain.
 * - `adopt`       the previous owner's account was deleted (the entitlement row
 *                 cascaded away but the ownership row remains); take it over.
 * - `first_claim` no ownership row at all, and the transaction was bought with
 *                 this account's token.
 * - `mismatch`    no ownership row, and the transaction belongs to someone else.
 */
export function classifyAppleChainClaim({
  state,
  uid,
  transactionToken,
  accountToken,
}) {
  const ownerUid = state?.ownerUid ?? null;
  if (ownerUid === uid) return "owner";
  if (ownerUid) return "conflict";
  if (state?.ownershipToken) return "adopt";
  return String(transactionToken || "").toLowerCase() ===
    String(accountToken || "").toLowerCase()
    ? "first_claim"
    : "mismatch";
}

function assertAppleOwnershipState(existing, record) {
  // The live-owner guard is the entitlement row, which cascades on account
  // deletion. The stored ownership token is immutable provenance and never
  // rejects a write: a released chain must stay adoptable, and an account must
  // be able to re-verify its own chain after its token changes. First-claim
  // token equality is enforced by classifyAppleChainClaim() before any write.
  if (
    (existing?.subscription_uid && existing.subscription_uid !== record.uid) ||
    (existing?.transaction_uid && existing.transaction_uid !== record.uid)
  ) {
    throw new AppleSubscriptionOwnershipError();
  }
}

export async function saveVerifiedAppleState(db, record) {
  // Serialize writers per chain so two accounts racing to adopt the same
  // released chain resolve to exactly one winner. The conditional upserts and
  // the re-read assertion below would also resolve it; this only removes the
  // interleaving.
  const release = await acquireKeyedLock(
    `apple-chain:${record.environment}:${record.originalTransactionId}`
  );
  try {
    return await writeVerifiedAppleState(db, record);
  } finally {
    release();
  }
}

async function writeVerifiedAppleState(db, record) {
  assertAppleOwnershipState(await readAppleOwnershipState(db, record), record);
  const now = Date.now();

  const ownership = await db.get(
    `INSERT INTO apple_subscription_ownership (
       environment, original_transaction_id, app_account_token,
       first_verified_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(environment, original_transaction_id) DO UPDATE SET
       app_account_token = apple_subscription_ownership.app_account_token
     WHERE lower(apple_subscription_ownership.app_account_token) =
             lower(excluded.app_account_token)
        OR NOT EXISTS (
             SELECT 1 FROM apple_subscriptions live_owner
              WHERE live_owner.environment = ?
                AND live_owner.original_transaction_id = ?
           )
        OR EXISTS (
             SELECT 1 FROM apple_subscriptions own_chain
              WHERE own_chain.environment = ?
                AND own_chain.original_transaction_id = ?
                AND own_chain.firebase_uid = ?
           )
     RETURNING app_account_token`,
    [
      record.environment,
      record.originalTransactionId,
      record.appAccountToken,
      now,
      record.environment,
      record.originalTransactionId,
      record.environment,
      record.originalTransactionId,
      record.uid,
    ]
  );
  if (!ownership) throw new AppleSubscriptionOwnershipError();

  // The entitlement row is authoritative and is written before the audit row.
  // If the process stops between writes, an idempotent retry repairs the audit
  // trail without temporarily losing already-verified access.
  await db.run(
    `INSERT INTO apple_subscriptions (
       environment, original_transaction_id, firebase_uid,
       latest_transaction_id, product_id, plan_id, status, expires_at,
       grace_expires_at, auto_renew_status, revoked_at, signed_date, verified_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(environment, original_transaction_id) DO UPDATE SET
       latest_transaction_id = excluded.latest_transaction_id,
       product_id = excluded.product_id,
       plan_id = excluded.plan_id,
       status = excluded.status,
       expires_at = excluded.expires_at,
       grace_expires_at = excluded.grace_expires_at,
       auto_renew_status = excluded.auto_renew_status,
       revoked_at = excluded.revoked_at,
       signed_date = excluded.signed_date,
       verified_at = excluded.verified_at
     WHERE apple_subscriptions.firebase_uid = excluded.firebase_uid
       AND excluded.signed_date >= apple_subscriptions.signed_date`,
    [
      record.environment,
      record.originalTransactionId,
      record.uid,
      record.transactionId,
      record.productId,
      record.planId,
      record.status,
      record.expiresAt,
      record.graceExpiresAt,
      record.autoRenewStatus,
      record.revokedAt,
      record.signedDate,
      now,
    ]
  );

  await db.run(
    `INSERT INTO apple_transactions (
       environment, transaction_id, original_transaction_id, firebase_uid,
       product_id, plan_id, purchase_date, expires_at, revoked_at,
       signed_date, verified_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(environment, transaction_id) DO UPDATE SET
       original_transaction_id = excluded.original_transaction_id,
       product_id = excluded.product_id,
       plan_id = excluded.plan_id,
       purchase_date = excluded.purchase_date,
       expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at,
       signed_date = excluded.signed_date,
       verified_at = excluded.verified_at
     WHERE apple_transactions.firebase_uid = excluded.firebase_uid
       AND excluded.signed_date >= apple_transactions.signed_date`,
    [
      record.environment,
      record.transactionId,
      record.originalTransactionId,
      record.uid,
      record.productId,
      record.planId,
      record.purchaseDate,
      record.expiresAt,
      record.revokedAt,
      record.signedDate,
      now,
    ]
  );

  // Re-read after the conditional upserts. This closes the race where two
  // Firebase users submit the same Apple transaction chain concurrently:
  // only the stored owner succeeds; the other receives a conflict.
  assertAppleOwnershipState(await readAppleOwnershipState(db, record), record);
}

export async function hasProcessedAppleNotification(
  db,
  environment,
  notificationUUID
) {
  const row = await db.get(
    `SELECT 1 AS found
       FROM apple_notification_events
      WHERE environment = ? AND notification_uuid = ?`,
    [environment, notificationUUID]
  );
  return Boolean(row);
}

export async function recordProcessedAppleNotification(db, event) {
  const result = await db.run(
    `INSERT OR IGNORE INTO apple_notification_events (
       environment, notification_uuid, notification_type, subtype,
       firebase_uid, signed_date, processed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.environment,
      event.notificationUUID,
      event.notificationType || null,
      event.subtype || null,
      event.uid || null,
      event.signedDate || null,
      Date.now(),
    ]
  );
  return Boolean(result?.changes);
}
