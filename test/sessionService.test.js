import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { buildSession } from "../src/session/sessionService.js";
import { saveVerifiedAppleState } from "../src/subscriptions/appleSubscriptionStore.js";

async function openSessionDb(t) {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  return db;
}

test("provisions a missing Firebase profile and returns the session contract", async (t) => {
  const db = await openSessionDb(t);
  const decoded = {
    uid: "firebase-user-123",
    email: "pantrio.user@example.com",
  };
  const now = new Date("2026-08-08T12:00:00.000Z");

  const session = await buildSession(db, decoded, { now });
  const repeated = await buildSession(db, decoded, { now });
  const rows = await db.get("SELECT COUNT(*) AS count FROM users WHERE uid = ?", [
    decoded.uid,
  ]);

  assert.deepEqual(session.user, {
    uid: decoded.uid,
    username: "pantrio.user",
  });
  assert.deepEqual(session.entitlement, {
    plan: "free",
    active: false,
    source: "client_unverified",
    verified: false,
    status: "unknown",
    productId: null,
    expiresAt: null,
    checkedAt: null,
    willAutoRenew: false,
    reportedActive: false,
  });
  assert.deepEqual(session.quota, {
    applies: true,
    limit: 20_000,
    used: 0,
    reserved: 0,
    remaining: 20_000,
    timezone: "America/Los_Angeles",
    resetsAt: "2026-08-09T07:00:00.000Z",
  });
  assert.deepEqual(session.model, {
    requested: null,
    effective: "gpt-5-mini",
    restricted: true,
  });
  assert.equal(session.apple.enabled, false);
  assert.match(
    session.apple.appAccountToken,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.equal(session.apple.appAccountToken, repeated.apple.appAccountToken);
  assert.ok(session.apple.products.length >= 1);
  assert.deepEqual(Object.keys(session.apple.products[0]).sort(), [
    "displayName",
    "planId",
    "productId",
  ]);
  assert.deepEqual(repeated.user, session.user);
  assert.equal(rows.count, 1);
});

test("applies the verified product's plan capabilities to the session", async (t) => {
  const db = await openSessionDb(t);
  const decoded = { uid: "verified-session-user", email: "paid@example.com" };
  const initial = await buildSession(db, decoded);
  const now = Date.now();
  await saveVerifiedAppleState(db, {
    uid: decoded.uid,
    appAccountToken: initial.apple.appAccountToken,
    environment: "Sandbox",
    transactionId: "session-transaction",
    originalTransactionId: "session-original",
    productId: "com.chilltech.pantrio.subscription.monthly",
    planId: "pro",
    status: 1,
    purchaseDate: now - 1_000,
    expiresAt: now + 86_400_000,
    graceExpiresAt: null,
    autoRenewStatus: 1,
    revokedAt: null,
    signedDate: now,
  });

  const session = await buildSession(db, decoded);
  assert.equal(session.entitlement.plan, "pro");
  assert.equal(session.entitlement.active, true);
  assert.equal(session.entitlement.verified, true);
  assert.equal(session.quota.applies, false);
  assert.equal(session.model.effective, "gpt-5");
  assert.equal(session.model.restricted, false);
});
