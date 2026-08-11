import { createHash, randomUUID } from "node:crypto";

import { resolveChatModel } from "../chat/modelPolicy.js";
import { getUserSubscription } from "../subscriptions/subscriptionStore.js";
import {
  resolveSubscriptionAccess,
  subscriptionToEntitlement,
} from "../subscriptions/entitlementPolicy.js";
import { getQuotaSnapshot } from "../usage/quotaSnapshot.js";
import { getAppleSessionConfiguration } from "../subscriptions/appleConfig.js";
import {
  AccountDeletionBlockedError,
  getAccountDeletion,
} from "../accountDeletion/accountDeletionStore.js";

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

  const deletion = await getAccountDeletion(db, decoded.uid);
  if (deletion) throw new AccountDeletionBlockedError(deletion);

  const existingProfile = await db.get(
    `SELECT uid, username, apple_app_account_token
       FROM users
      WHERE uid = ?`,
    [decoded.uid]
  );
  if (existingProfile?.apple_app_account_token) return existingProfile;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accountToken = String(accountTokenFactory()).toLowerCase();
    try {
      return await db.get(
        `INSERT INTO users (
           uid, username, apple_app_account_token, created_at, updated_at
         )
         VALUES (?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
         ON CONFLICT(uid) DO UPDATE SET
           apple_app_account_token = COALESCE(
             users.apple_app_account_token,
             excluded.apple_app_account_token
           )
         RETURNING uid, username, apple_app_account_token`,
        [decoded.uid, fallbackUsername(decoded), accountToken]
      );
    } catch (error) {
      if (attempt === 2 || !String(error?.code || "").includes("CONSTRAINT")) {
        throw error;
      }
    }
  }
}

export async function buildSession(
  db,
  decoded,
  { now = new Date(), profile: suppliedProfile = null } = {}
) {
  if (suppliedProfile && suppliedProfile.uid !== decoded?.uid) {
    throw new TypeError("profile.uid must match decoded.uid");
  }

  let profile = suppliedProfile;
  if (profile) {
    // A route may reuse a profile it loaded before a remote Apple request, but
    // the final session response must still fail closed if deletion began in
    // the meantime.
    const deletion = await getAccountDeletion(db, decoded.uid);
    if (deletion) throw new AccountDeletionBlockedError(deletion);
  } else {
    profile = await ensureUserProfile(db, decoded);
  }
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
  const finalDeletion = await getAccountDeletion(db, decoded.uid);
  if (finalDeletion) throw new AccountDeletionBlockedError(finalDeletion);

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
