import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_SNAPSHOT_MAX_AGE_MS,
  SubscriptionStatusValidationError,
  deriveIsSubscribed,
  normalizeSubscriptionSnapshot,
  subscriptionRowToPublic,
} from "../src/subscriptions/subscriptionStatus.js";

const FIXED_NOW_MS = Date.parse("2026-08-08T09:00:00Z");

test("requires ordering and expiration fields for active entitlement", () => {
  assert.throws(
    () =>
      normalizeSubscriptionSnapshot(
        {
          status: "subscribed",
          isEntitled: true,
          checkedAt: "2026-08-08T08:00:00Z",
        },
        { nowMs: FIXED_NOW_MS }
      ),
    SubscriptionStatusValidationError
  );
});

test("normalizes optional client fields and drops extra transaction data", () => {
  assert.deepEqual(
    normalizeSubscriptionSnapshot(
      {
        status: "in_grace_period",
        isEntitled: true,
        productId: "  com.chilltech.pantrio.pro.monthly  ",
        expirationDate: "2026-08-08T01:02:03-07:00",
        checkedAt: "2026-08-08T08:03:04.123Z",
        willAutoRenew: true,
        isPartial: false,
        subscriptions: [{ transactionId: "untrusted" }],
        reason: "transaction_updated",
      },
      { nowMs: FIXED_NOW_MS }
    ),
    {
      source: "client_unverified",
      verified: false,
      status: "in_grace_period",
      isEntitled: true,
      isSubscribed: true,
      productId: "com.chilltech.pantrio.pro.monthly",
      expirationDate: "2026-08-08T08:02:03.000Z",
      checkedAt: "2026-08-08T08:03:04.123Z",
      willAutoRenew: true,
      isPartial: false,
    }
  );
});

test("derives subscription access conservatively", () => {
  const activeFields = {
    productId: "com.chilltech.pantrio.pro.monthly",
    expirationDate: "2026-09-08T00:00:00Z",
    checkedAt: "2026-08-08T08:00:00Z",
    nowMs: FIXED_NOW_MS,
  };

  assert.equal(deriveIsSubscribed("subscribed", true, activeFields), true);
  assert.equal(
    deriveIsSubscribed("in_grace_period", true, activeFields),
    true
  );
  assert.equal(deriveIsSubscribed("subscribed", false, activeFields), false);

  for (const status of KNOWN_SUBSCRIPTION_STATUSES) {
    if (status === "subscribed" || status === "in_grace_period") continue;
    assert.equal(deriveIsSubscribed(status, true, activeFields), false, status);
  }

  const inconsistent = normalizeSubscriptionSnapshot(
    {
      status: "expired",
      isEntitled: true,
      checkedAt: "2026-08-08T08:00:00Z",
    },
    { nowMs: FIXED_NOW_MS }
  );
  assert.equal(inconsistent.isEntitled, true);
  assert.equal(inconsistent.isSubscribed, false);
});

test("fails closed for stale, expired, future, and partial snapshots", () => {
  const base = {
    status: "subscribed",
    isEntitled: true,
    productId: "com.chilltech.pantrio.pro.monthly",
    expirationDate: "2026-09-08T00:00:00Z",
    checkedAt: "2026-08-08T08:00:00Z",
  };

  assert.equal(
    normalizeSubscriptionSnapshot(
      {
        ...base,
        checkedAt: new Date(
          FIXED_NOW_MS - SUBSCRIPTION_SNAPSHOT_MAX_AGE_MS - 1
        ).toISOString(),
      },
      { nowMs: FIXED_NOW_MS }
    ).isSubscribed,
    false
  );
  assert.equal(
    normalizeSubscriptionSnapshot(
      { ...base, expirationDate: "2026-08-08T08:59:59Z" },
      { nowMs: FIXED_NOW_MS }
    ).isSubscribed,
    false
  );
  assert.equal(
    normalizeSubscriptionSnapshot(
      { ...base, isPartial: true },
      { nowMs: FIXED_NOW_MS }
    ).isSubscribed,
    false
  );
  assert.equal(
    normalizeSubscriptionSnapshot(
      {
        status: "subscribed",
        isEntitled: true,
        checkedAt: "2026-08-08T08:00:00Z",
        isPartial: true,
      },
      { nowMs: FIXED_NOW_MS }
    ).isSubscribed,
    false
  );
  assert.throws(
    () =>
      normalizeSubscriptionSnapshot(
        { ...base, checkedAt: "2026-08-08T09:06:00Z" },
        { nowMs: FIXED_NOW_MS }
      ),
    /five minutes/
  );
});

test("rejects missing, transient, and unknown statuses", () => {
  const invalidSnapshots = [
    { isEntitled: false },
    { status: 1, isEntitled: false },
    { status: "loading", isEntitled: false },
    { status: "active", isEntitled: true },
    { status: " subscribed ", isEntitled: true },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(
      () => normalizeSubscriptionSnapshot(snapshot),
      SubscriptionStatusValidationError
    );
  }
});

test("requires isEntitled to be a boolean", () => {
  for (const isEntitled of [undefined, null, 0, 1, "true"]) {
    const snapshot = {
      status: "not_subscribed",
      checkedAt: "2026-08-08T08:00:00Z",
    };
    if (isEntitled !== undefined) snapshot.isEntitled = isEntitled;

    assert.throws(
      () => normalizeSubscriptionSnapshot(snapshot),
      SubscriptionStatusValidationError
    );
  }
});

test("rejects malformed optional fields", () => {
  const base = {
    status: "not_subscribed",
    isEntitled: false,
    checkedAt: "2026-08-08T08:00:00Z",
  };

  for (const extra of [
    { productId: 42 },
    { expirationDate: "tomorrow" },
    { expirationDate: "2026-02-30T00:00:00Z" },
    { checkedAt: 1_786_160_000_000 },
    { willAutoRenew: 1 },
    { isPartial: 1 },
  ]) {
    assert.throws(
      () => normalizeSubscriptionSnapshot({ ...base, ...extra }),
      SubscriptionStatusValidationError
    );
  }
});

test("converts a prefixed SQLite row to the public subscription shape", () => {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expirationDate = new Date(Date.now() + 86_400_000).toISOString();

  assert.deepEqual(
    subscriptionRowToPublic({
      subscription_status: "subscribed",
      subscription_is_entitled: 1,
      subscription_is_subscribed: 0,
      subscription_product_id: "com.chilltech.pantrio.pro.yearly",
      subscription_expiration_date: expirationDate,
      subscription_checked_at: checkedAt,
      subscription_will_auto_renew: 1,
      subscription_is_partial: 0,
    }),
    {
      source: "client_unverified",
      verified: false,
      status: "subscribed",
      isEntitled: true,
      isSubscribed: true,
      productId: "com.chilltech.pantrio.pro.yearly",
      expirationDate,
      checkedAt,
      willAutoRenew: true,
      isPartial: false,
    }
  );
});

test("converts unprefixed rows and fails closed for inconsistent data", () => {
  assert.deepEqual(
    subscriptionRowToPublic({
      status: "expired",
      is_entitled: 1,
      product_id: 123,
      expiration_date: "invalid",
      checked_at: "",
      will_auto_renew: "1",
      is_partial: 1,
    }),
    {
      source: "client_unverified",
      verified: false,
      status: "expired",
      isEntitled: true,
      isSubscribed: false,
      productId: null,
      expirationDate: null,
      checkedAt: null,
      willAutoRenew: false,
      isPartial: true,
    }
  );
});

test("returns a stable not-subscribed object for a missing DB row", () => {
  assert.deepEqual(subscriptionRowToPublic(null), {
    source: "client_unverified",
    verified: false,
    status: "not_subscribed",
    isEntitled: false,
    isSubscribed: false,
    productId: null,
    expirationDate: null,
    checkedAt: null,
    willAutoRenew: false,
    isPartial: false,
  });
});
