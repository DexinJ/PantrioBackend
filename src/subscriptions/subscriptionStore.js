// src/subscriptions/subscriptionStore.js
import {
  normalizeSubscriptionSnapshot,
  subscriptionRowToPublic,
} from "./subscriptionStatus.js";
import { getVerifiedAppleSubscription } from "./appleSubscriptionStore.js";

const SUBSCRIPTION_COLUMNS = `
  subscription_status,
  subscription_is_entitled,
  subscription_product_id,
  subscription_expiration_date,
  subscription_checked_at,
  subscription_will_auto_renew,
  subscription_is_partial
`;

export async function getUserSubscription(db, uid) {
  const verifiedAppleSubscription = await getVerifiedAppleSubscription(db, uid);
  if (verifiedAppleSubscription) return verifiedAppleSubscription;

  const row = await db.get(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM users
      WHERE uid = ?`,
    [uid]
  );

  return subscriptionRowToPublic(row);
}

export async function saveUserSubscription(db, uid, snapshot) {
  const subscription = normalizeSubscriptionSnapshot(snapshot);
  const now = Date.now();

  const result = await db.run(
    `UPDATE users
        SET subscription_status = ?,
            subscription_is_entitled = ?,
            subscription_product_id = ?,
            subscription_expiration_date = ?,
            subscription_checked_at = ?,
            subscription_will_auto_renew = ?,
            subscription_is_partial = ?,
            subscription_updated_at = ?,
            updated_at = strftime('%s', 'now')
      WHERE uid = ?
        AND (
          subscription_checked_at IS NULL OR
          subscription_checked_at < ?
        )`,
    [
      subscription.status,
      subscription.isEntitled ? 1 : 0,
      subscription.productId,
      subscription.expirationDate,
      subscription.checkedAt,
      subscription.willAutoRenew ? 1 : 0,
      subscription.isPartial ? 1 : 0,
      now,
      uid,
      subscription.checkedAt,
    ]
  );

  if (!result?.changes) {
    const existingRow = await db.get(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM users
        WHERE uid = ?`,
      [uid]
    );

    return existingRow ? subscriptionRowToPublic(existingRow) : null;
  }

  return getUserSubscription(db, uid);
}
