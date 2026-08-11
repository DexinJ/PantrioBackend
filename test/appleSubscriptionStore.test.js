import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import {
  AppleSubscriptionOwnershipError,
  findUserByAppleAccountToken,
  saveVerifiedAppleState,
} from "../src/subscriptions/appleSubscriptionStore.js";
import { getUserSubscription } from "../src/subscriptions/subscriptionStore.js";

async function openDb(t) {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  return db;
}

function state(uid, overrides = {}) {
  const now = Date.now();
  return {
    uid,
    environment: "Sandbox",
    transactionId: `transaction-${uid}`,
    originalTransactionId: "original-shared",
    appAccountToken: "1b574614-4789-4a3a-b8d4-bd16b6814b30",
    productId: "com.chilltech.pantrio.subscription.monthly",
    planId: "pro",
    status: 1,
    purchaseDate: now - 1_000,
    expiresAt: now + 86_400_000,
    graceExpiresAt: null,
    autoRenewStatus: 1,
    revokedAt: null,
    signedDate: now,
    ...overrides,
  };
}

test("verified Apple state takes precedence over client telemetry", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at,
       subscription_status, subscription_is_entitled
     ) VALUES (?, ?, ?, 1, 1, 'expired', 0)`,
    ["verified-user", "verified", "1b574614-4789-4a3a-b8d4-bd16b6814b30"]
  );
  await saveVerifiedAppleState(db, state("verified-user"));

  const subscription = await getUserSubscription(db, "verified-user");
  assert.equal(subscription.source, "apple_server");
  assert.equal(subscription.verified, true);
  assert.equal(subscription.isSubscribed, true);
  assert.equal(subscription.planId, "pro");
});

test("a transaction chain cannot be linked to a second Firebase user", async (t) => {
  const db = await openDb(t);
  for (const uid of ["owner-a", "owner-b"]) {
    await db.run(
      `INSERT INTO users (uid, username, created_at, updated_at)
       VALUES (?, ?, 1, 1)`,
      [uid, uid]
    );
  }
  await saveVerifiedAppleState(db, state("owner-a"));
  await assert.rejects(
    saveVerifiedAppleState(
      db,
      state("owner-b", { transactionId: "different-transaction" })
    ),
    AppleSubscriptionOwnershipError
  );
});

test("account deletion preserves a non-user ownership tombstone", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('deleted-owner', 'deleted', 1, 1)`
  );
  await saveVerifiedAppleState(db, state("deleted-owner"));
  await db.run("DELETE FROM users WHERE uid = 'deleted-owner'");
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('new-owner', 'new', 1, 1)`
  );

  await assert.rejects(
    saveVerifiedAppleState(
      db,
      state("new-owner", {
        transactionId: "new-transaction",
        appAccountToken: "4a54ef16-bf76-4e1a-87fe-a55db3042c07",
      })
    ),
    AppleSubscriptionOwnershipError
  );
});

test("finds app-account tokens through the normalized lookup contract", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES ('token-owner', 'owner', 'Mixed-Token-Value', 1, 1)`
  );

  assert.deepEqual(
    await findUserByAppleAccountToken(db, "  MIXED-token-value  "),
    {
      uid: "token-owner",
      apple_app_account_token: "Mixed-Token-Value",
    }
  );
});
