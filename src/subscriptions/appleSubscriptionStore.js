import { isAppleEnvironmentAllowed } from "./appleConfig.js";
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
  const rows = await db.all(
    `SELECT *
       FROM apple_subscriptions
      WHERE firebase_uid = ?
      ORDER BY
        CASE WHEN status IN (1, 4) THEN 0 ELSE 1 END,
        verified_at DESC`,
    [uid]
  );
  const nowMs = Date.now();
  const candidates = rows
    .filter((candidate) => isAppleEnvironmentAllowed(candidate.environment))
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
  const rows = await db.all(
    `SELECT environment, latest_transaction_id, original_transaction_id
       FROM apple_subscriptions
      WHERE firebase_uid = ?
      ORDER BY verified_at DESC`,
    [uid]
  );
  return (
    rows.find((candidate) => isAppleEnvironmentAllowed(candidate.environment)) ||
    null
  );
}

export async function findUserByAppleAccountToken(db, appAccountToken) {
  if (!appAccountToken) return null;
  return db.get(
    `SELECT uid, apple_app_account_token
       FROM users
      WHERE lower(apple_app_account_token) = lower(?)`,
    [appAccountToken]
  );
}

async function assertSubscriptionOwner(db, record) {
  const existing = await db.get(
    `SELECT firebase_uid
       FROM apple_subscriptions
      WHERE environment = ? AND original_transaction_id = ?`,
    [record.environment, record.originalTransactionId]
  );
  if (existing && existing.firebase_uid !== record.uid) {
    throw new AppleSubscriptionOwnershipError();
  }
}

async function assertOwnershipToken(db, record) {
  const existing = await db.get(
    `SELECT app_account_token
       FROM apple_subscription_ownership
      WHERE environment = ? AND original_transaction_id = ?`,
    [record.environment, record.originalTransactionId]
  );
  if (
    existing &&
    existing.app_account_token.toLowerCase() !==
      String(record.appAccountToken || "").toLowerCase()
  ) {
    throw new AppleSubscriptionOwnershipError();
  }
}

async function assertTransactionOwner(db, record) {
  const existing = await db.get(
    `SELECT firebase_uid
       FROM apple_transactions
      WHERE environment = ? AND transaction_id = ?`,
    [record.environment, record.transactionId]
  );
  if (existing && existing.firebase_uid !== record.uid) {
    throw new AppleSubscriptionOwnershipError();
  }
}

export async function saveVerifiedAppleState(db, record) {
  await assertOwnershipToken(db, record);
  await assertSubscriptionOwner(db, record);
  await assertTransactionOwner(db, record);
  const now = Date.now();

  await db.run(
    `INSERT OR IGNORE INTO apple_subscription_ownership (
       environment, original_transaction_id, app_account_token,
       first_verified_at
     ) VALUES (?, ?, ?, ?)`,
    [
      record.environment,
      record.originalTransactionId,
      record.appAccountToken,
      now,
    ]
  );
  await assertOwnershipToken(db, record);

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
  await assertTransactionOwner(db, record);
  await assertSubscriptionOwner(db, record);
  await assertOwnershipToken(db, record);
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
