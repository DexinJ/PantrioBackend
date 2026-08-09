import assert from "node:assert/strict";
import test from "node:test";

import {
  canUseSubscriptionAccess,
  subscriptionToEntitlement,
} from "../src/subscriptions/entitlementPolicy.js";

const REPORTED_SUBSCRIPTION = {
  isSubscribed: true,
  verified: false,
  source: "client_unverified",
  status: "subscribed",
  productId: "com.chilltech.pantrio.pro.monthly",
  expirationDate: "2026-09-08T00:00:00.000Z",
  checkedAt: "2026-08-08T12:00:00.000Z",
  willAutoRenew: true,
};

test("fails closed for an unverified client subscription", () => {
  assert.equal(
    canUseSubscriptionAccess(REPORTED_SUBSCRIPTION, {
      allowUnverifiedSubscriptions: false,
    }),
    false
  );
});

test("allows verified access and the explicit development override", () => {
  assert.equal(
    canUseSubscriptionAccess(
      { ...REPORTED_SUBSCRIPTION, verified: true },
      { allowUnverifiedSubscriptions: false }
    ),
    true
  );
  assert.equal(
    canUseSubscriptionAccess(REPORTED_SUBSCRIPTION, {
      allowUnverifiedSubscriptions: true,
    }),
    true
  );
});

test("never grants access when the normalized subscription is inactive", () => {
  assert.equal(
    canUseSubscriptionAccess(
      { ...REPORTED_SUBSCRIPTION, isSubscribed: false, verified: true },
      { allowUnverifiedSubscriptions: true }
    ),
    false
  );
});

test("exposes reported state without presenting it as active entitlement", () => {
  assert.deepEqual(
    subscriptionToEntitlement(REPORTED_SUBSCRIPTION, {
      allowUnverifiedSubscriptions: false,
    }),
    {
      plan: "free",
      active: false,
      source: "client_unverified",
      verified: false,
      status: "subscribed",
      productId: "com.chilltech.pantrio.pro.monthly",
      expiresAt: "2026-09-08T00:00:00.000Z",
      checkedAt: "2026-08-08T12:00:00.000Z",
      willAutoRenew: true,
      reportedActive: true,
    }
  );
});
