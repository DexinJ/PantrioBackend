import assert from "node:assert/strict";
import test from "node:test";

import {
  QUOTA_TIMEZONE,
  createQuotaSnapshot,
  getNextQuotaResetAt,
  quotaLegacyFields,
} from "../src/usage/quotaSnapshot.js";

test("computes the next Los Angeles midnight across standard and daylight time", () => {
  assert.equal(
    getNextQuotaResetAt(new Date("2026-01-10T20:00:00.000Z")),
    "2026-01-11T08:00:00.000Z"
  );
  assert.equal(
    getNextQuotaResetAt(new Date("2026-08-08T12:00:00.000Z")),
    "2026-08-09T07:00:00.000Z"
  );
});

test("returns the stable quota contract for quota-limited users", () => {
  const quota = createQuotaSnapshot({
    applies: true,
    tokensUsed: 4_200,
    dailyLimit: 20_000,
    now: new Date("2026-08-08T12:00:00.000Z"),
  });

  assert.deepEqual(quota, {
    applies: true,
    limit: 20_000,
    used: 4_200,
    reserved: 0,
    remaining: 15_800,
    timezone: QUOTA_TIMEZONE,
    resetsAt: "2026-08-09T07:00:00.000Z",
  });
});

test("returns a non-applying quota without exposing a numeric limit", () => {
  const quota = createQuotaSnapshot({
    applies: false,
    tokensUsed: 9_000,
    now: new Date("2026-08-08T12:00:00.000Z"),
  });

  assert.deepEqual(quota, {
    applies: false,
    limit: null,
    used: 0,
    reserved: 0,
    remaining: null,
    timezone: QUOTA_TIMEZONE,
    resetsAt: "2026-08-09T07:00:00.000Z",
  });
});

test("maps a quota snapshot to compatibility fields", () => {
  assert.deepEqual(
    quotaLegacyFields({
      limit: 20_000,
      used: 125,
      remaining: 19_875,
      resetsAt: "2026-08-09T07:00:00.000Z",
    }),
    {
      dailyLimit: 20_000,
      usedTokens: 125,
      remainingTokens: 19_875,
      resetsAt: "2026-08-09T07:00:00.000Z",
    }
  );
});

test("rejects invalid snapshot inputs", () => {
  assert.throws(() => createQuotaSnapshot({ applies: "yes" }), /applies/);
  assert.throws(
    () =>
      createQuotaSnapshot({
        applies: true,
        tokensUsed: -1,
      }),
    /tokensUsed/
  );
  assert.throws(
    () => getNextQuotaResetAt(new Date("invalid")),
    /valid Date/
  );
});
