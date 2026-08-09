// src/db/initDb.js
import fs from "fs";
import path from "path";
import { getDb } from "./db.js";

const USER_SUBSCRIPTION_COLUMN_MIGRATIONS = [
  {
    name: "apple_app_account_token",
    sql: "ALTER TABLE users ADD COLUMN apple_app_account_token TEXT DEFAULT NULL",
  },
  {
    name: "subscription_status",
    sql: "ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    name: "subscription_is_entitled",
    sql: "ALTER TABLE users ADD COLUMN subscription_is_entitled INTEGER NOT NULL DEFAULT 0 CHECK(subscription_is_entitled IN (0, 1))",
  },
  {
    name: "subscription_product_id",
    sql: "ALTER TABLE users ADD COLUMN subscription_product_id TEXT DEFAULT NULL",
  },
  {
    name: "subscription_expiration_date",
    sql: "ALTER TABLE users ADD COLUMN subscription_expiration_date TEXT DEFAULT NULL",
  },
  {
    name: "subscription_checked_at",
    sql: "ALTER TABLE users ADD COLUMN subscription_checked_at TEXT DEFAULT NULL",
  },
  {
    name: "subscription_will_auto_renew",
    sql: "ALTER TABLE users ADD COLUMN subscription_will_auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(subscription_will_auto_renew IN (0, 1))",
  },
  {
    name: "subscription_is_partial",
    sql: "ALTER TABLE users ADD COLUMN subscription_is_partial INTEGER NOT NULL DEFAULT 0 CHECK(subscription_is_partial IN (0, 1))",
  },
  {
    name: "subscription_updated_at",
    sql: "ALTER TABLE users ADD COLUMN subscription_updated_at INTEGER NOT NULL DEFAULT 0",
  },
];

// async function migrateUserSubscriptionColumns(db) {
export async function migrateUserSubscriptionColumns(db) {
  const columns = await db.all("PRAGMA table_info(users)");
  const existingColumnNames = new Set(columns.map((column) => column.name));

  for (const migration of USER_SUBSCRIPTION_COLUMN_MIGRATIONS) {
    if (!existingColumnNames.has(migration.name)) {
      await db.exec(migration.sql);
    }
  }

  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_app_account_token ON users(apple_app_account_token)"
  );
}

export async function initDb() {
  const db = await getDb();

  const schemaPath = path.join(process.cwd(), "src/db/schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  await db.exec(schema);
  await migrateUserSubscriptionColumns(db);

  console.log("✅ Database schema initialized");
}
