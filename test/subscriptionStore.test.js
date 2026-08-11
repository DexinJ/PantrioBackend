import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { migrateUserSubscriptionColumns } from "../src/db/initDb.js";
import {
  getUserSubscription,
  saveUserSubscription,
} from "../src/subscriptions/subscriptionStore.js";

async function openMemoryDb(t) {
  const db = await open({
    filename: ":memory:",
    driver: sqlite3.Database,
  });
  t.after(() => db.close());
  return db;
}

test("migrates populated legacy user tables once and fails closed", async (t) => {
  const db = await openMemoryDb(t);

  await db.exec(`
    CREATE TABLE users (
      uid TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (uid, username, created_at, updated_at)
    VALUES ('legacy-user', 'legacy', 1, 1);
  `);

  await migrateUserSubscriptionColumns(db);
  await migrateUserSubscriptionColumns(db);

  const columns = await db.all("PRAGMA table_info(users)");
  const subscriptionColumns = columns
    .map((column) => column.name)
    .filter((name) => name.startsWith("subscription_"));
  const row = await db.get(
    `SELECT subscription_status,
            subscription_is_entitled,
            subscription_product_id,
            subscription_expiration_date,
            subscription_checked_at,
            subscription_will_auto_renew,
            subscription_is_partial,
            subscription_updated_at
       FROM users
      WHERE uid = 'legacy-user'`
  );

  assert.equal(subscriptionColumns.length, 8);
  const normalizedTokenIndex = await db.get(
    `SELECT sql
       FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_users_apple_app_account_token_normalized'`
  );
  assert.match(normalizedTokenIndex.sql, /lower\(apple_app_account_token\)/i);
  assert.deepEqual(row, {
    subscription_status: "unknown",
    subscription_is_entitled: 0,
    subscription_product_id: null,
    subscription_expiration_date: null,
    subscription_checked_at: null,
    subscription_will_auto_renew: 0,
    subscription_is_partial: 0,
    subscription_updated_at: 0,
  });
});

test("persists and reads the normalized StoreKit subscription snapshot", async (t) => {
  const db = await openMemoryDb(t);
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES (?, ?, 1, 1)`,
    ["paid-user", "paid"]
  );

  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expirationDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const saved = await saveUserSubscription(db, "paid-user", {
    status: "subscribed",
    isEntitled: true,
    productId: "com.chilltech.pantrio.pro.monthly",
    expirationDate,
    checkedAt,
    willAutoRenew: true,
    isPartial: false,
  });
  const loaded = await getUserSubscription(db, "paid-user");

  assert.equal(saved.isSubscribed, true);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.productId, "com.chilltech.pantrio.pro.monthly");
});

test("inactive and missing users are treated as unsubscribed", async (t) => {
  const db = await openMemoryDb(t);
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES (?, ?, 1, 1)`,
    ["free-user", "free"]
  );

  const expired = await saveUserSubscription(db, "free-user", {
    status: "expired",
    isEntitled: false,
    checkedAt: new Date().toISOString(),
  });
  const missing = await getUserSubscription(db, "missing-user");

  assert.equal(expired.isSubscribed, false);
  assert.equal(missing.isSubscribed, false);
  assert.equal(missing.status, "not_subscribed");
});

test("does not let an older StoreKit snapshot overwrite a newer one", async (t) => {
  const db = await openMemoryDb(t);
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES (?, ?, 1, 1)`,
    ["ordered-user", "ordered"]
  );

  const now = Date.now();
  const newerCheckedAt = new Date(now - 30_000).toISOString();
  const olderCheckedAt = new Date(now - 60_000).toISOString();
  const expirationDate = new Date(now + 86_400_000).toISOString();

  await saveUserSubscription(db, "ordered-user", {
    status: "subscribed",
    isEntitled: true,
    productId: "com.chilltech.pantrio.pro.monthly",
    expirationDate,
    checkedAt: newerCheckedAt,
  });
  const afterStaleWrite = await saveUserSubscription(db, "ordered-user", {
    status: "expired",
    isEntitled: false,
    checkedAt: olderCheckedAt,
  });

  assert.equal(afterStaleWrite.status, "subscribed");
  assert.equal(afterStaleWrite.checkedAt, newerCheckedAt);
  assert.equal(afterStaleWrite.isSubscribed, true);
});
