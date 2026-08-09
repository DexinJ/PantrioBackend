import { ALLOW_UNVERIFIED_SUBSCRIPTIONS } from "../config/policy.js";
import {
  FREE_PLAN,
  SUBSCRIPTION_PLANS,
  getPlanByProductId,
} from "./planCatalog.js";

export function canUseSubscriptionAccess(
  subscription,
  { allowUnverifiedSubscriptions = ALLOW_UNVERIFIED_SUBSCRIPTIONS } = {}
) {
  if (subscription?.isSubscribed !== true) return false;
  if (subscription?.verified === true) return true;
  return allowUnverifiedSubscriptions === true;
}

export function subscriptionToEntitlement(
  subscription,
  options
) {
  const active = canUseSubscriptionAccess(subscription, options);
  const plan = active
    ? getPlanByProductId(subscription?.productId) || SUBSCRIPTION_PLANS[0]
    : FREE_PLAN;

  return {
    plan: plan.id,
    active,
    source: subscription?.source || "client_unverified",
    verified: subscription?.verified === true,
    status: subscription?.status || "not_subscribed",
    productId: subscription?.productId || null,
    expiresAt: subscription?.expirationDate || null,
    checkedAt: subscription?.checkedAt || null,
    willAutoRenew: subscription?.willAutoRenew === true,
    reportedActive: subscription?.isSubscribed === true,
  };
}

export function resolveSubscriptionAccess(subscription, options) {
  const active = canUseSubscriptionAccess(subscription, options);
  const plan = active
    ? getPlanByProductId(subscription?.productId) || SUBSCRIPTION_PLANS[0]
    : FREE_PLAN;

  return { active, plan };
}
