import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import {
  buildSession,
  ensureUserProfile,
} from "../src/session/sessionService.js";
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

test("an existing complete profile avoids provisioning writes and token generation", async (t) => {
  const db = await openSessionDb(t);
  const decoded = { uid: "existing-profile", email: "existing@example.com" };
  const initial = await ensureUserProfile(db, decoded);
  const originalRun = db.run.bind(db);
  let writeCount = 0;
  db.run = (...args) => {
    writeCount += 1;
    return originalRun(...args);
  };

  const repeated = await ensureUserProfile(db, decoded, {
    accountTokenFactory() {
      throw new Error("existing profiles must not generate a new token");
    },
  });

  assert.deepEqual(repeated, initial);
  assert.equal(writeCount, 0);
});

test("a supplied profile still performs the final deletion guard", async (t) => {
  const db = await openSessionDb(t);
  const decoded = { uid: "deleted-session", email: "deleted@example.com" };
  const profile = await ensureUserProfile(db, decoded);
  await db.run(
    `INSERT INTO account_deletions (
       firebase_uid, status, firebase_status, local_data_status,
       apple_identity_linked, apple_revocation_status, requested_at, updated_at
     ) VALUES (?, 'processing', 'pending', 'pending', 0, 'not_linked', 1, 1)`,
    [decoded.uid]
  );

  await assert.rejects(
    buildSession(db, decoded, { profile }),
    (error) => error.code === "ACCOUNT_DELETION_IN_PROGRESS" && error.status === 410
  );
});

test("session construction fails closed when deletion starts during quota reads", async (t) => {
  const db = await openSessionDb(t);
  const decoded = { uid: "racing-session", email: "race@example.com" };
  const profile = await ensureUserProfile(db, decoded);
  let deletionChecks = 0;
  const racingDb = new Proxy(db, {
    get(target, property) {
      if (property === "get") {
        return async (sql, ...args) => {
          if (String(sql).includes("FROM account_deletions")) {
            deletionChecks += 1;
            if (deletionChecks === 2) {
              await target.run(
                `INSERT INTO account_deletions (
                   firebase_uid, status, firebase_status, local_data_status,
                   apple_identity_linked, apple_revocation_status,
                   requested_at, updated_at
                 ) VALUES (?, 'processing', 'pending', 'pending', 0,
                           'not_linked', 1, 1)`,
                [decoded.uid]
              );
            }
          }
          return target.get(sql, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    buildSession(racingDb, decoded, { profile }),
    (error) => error.code === "ACCOUNT_DELETION_IN_PROGRESS" && error.status === 410
  );
  assert.equal(deletionChecks, 2);
});
