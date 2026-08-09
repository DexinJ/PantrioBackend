import { createHash, randomUUID } from "node:crypto";

import { resolveChatModel } from "../chat/modelPolicy.js";
import { getUserSubscription } from "../subscriptions/subscriptionStore.js";
import {
  resolveSubscriptionAccess,
  subscriptionToEntitlement,
} from "../subscriptions/entitlementPolicy.js";
import { getQuotaSnapshot } from "../usage/quotaSnapshot.js";
import { getAppleSessionConfiguration } from "../subscriptions/appleConfig.js";

function usableUsername(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 ? normalized.slice(0, 20) : null;
}

export function fallbackUsername(decoded) {
  const fromName = usableUsername(decoded?.name);
  if (fromName) return fromName;

  const emailPrefix =
    typeof decoded?.email === "string" ? decoded.email.split("@")[0] : null;
  const fromEmail = usableUsername(emailPrefix);
  if (fromEmail) return fromEmail;

  const uid = String(decoded?.uid || "");
  const suffix = createHash("sha256").update(uid).digest("hex").slice(0, 12);
  return `user_${suffix}`;
}

export async function ensureUserProfile(
  db,
  decoded,
  { accountTokenFactory = randomUUID } = {}
) {
  if (!decoded?.uid) throw new TypeError("decoded.uid is required");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accountToken = accountTokenFactory();
    try {
      await db.run(
        `INSERT INTO users (
           uid, username, apple_app_account_token, created_at, updated_at
         )
         VALUES (?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
         ON CONFLICT(uid) DO NOTHING`,
        [decoded.uid, fallbackUsername(decoded), accountToken]
      );
      await db.run(
        `UPDATE users
            SET apple_app_account_token = ?
          WHERE uid = ? AND apple_app_account_token IS NULL`,
        [accountToken, decoded.uid]
      );
      break;
    } catch (error) {
      if (attempt === 2 || !String(error?.code || "").includes("CONSTRAINT")) {
        throw error;
      }
    }
  }

  return db.get(
    `SELECT uid, username, apple_app_account_token
       FROM users
      WHERE uid = ?`,
    [decoded.uid]
  );
}

export async function buildSession(db, decoded, { now = new Date() } = {}) {
  const profile = await ensureUserProfile(db, decoded);
  const user = { uid: profile.uid, username: profile.username };
  const subscription = await getUserSubscription(db, decoded.uid);
  const { active: isSubscribed, plan } = resolveSubscriptionAccess(subscription);
  const quota = await getQuotaSnapshot(
    db,
    "user",
    decoded.uid,
    plan.dailyTokenLimit !== null,
    { now, dailyLimit: plan.dailyTokenLimit ?? undefined }
  );
  const modelResolution = resolveChatModel({
    requestedModel: null,
    isSubscribed,
    plan,
  });
  const appleConfiguration = getAppleSessionConfiguration();

  return {
    user,
    entitlement: subscriptionToEntitlement(subscription),
    quota,
    model: {
      requested: null,
      effective: modelResolution.model,
      restricted: plan.id === "free",
    },
    apple: {
      enabled: appleConfiguration.enabled,
      appAccountToken: profile.apple_app_account_token,
      products: appleConfiguration.products,
    },
  };
}
