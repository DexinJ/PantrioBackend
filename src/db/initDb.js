// src/db/initDb.js
import fs from "fs";
import { getDb } from "./db.js";

const SCHEMA_URL = new URL("./schema.sql", import.meta.url);
export const DATABASE_SCHEMA_VERSION = 2;

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

const ACCOUNT_DELETION_COLUMN_MIGRATIONS = [
  {
    name: "firebase_deletion_attempts",
    sql: "ALTER TABLE account_deletions ADD COLUMN firebase_deletion_attempts INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "firebase_next_retry_at",
    sql: "ALTER TABLE account_deletions ADD COLUMN firebase_next_retry_at INTEGER DEFAULT NULL",
  },
];

// async function migrateUserSubscriptionColumns(db) {
export async function migrateUserSubscriptionColumns(db) {
  const columns = await db.all("PRAGMA table_info(users)");
  if (columns.length === 0) return;
  const existingColumnNames = new Set(columns.map((column) => column.name));

  for (const migration of USER_SUBSCRIPTION_COLUMN_MIGRATIONS) {
    if (!existingColumnNames.has(migration.name)) {
      await db.exec(migration.sql);
    }
  }

  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_app_account_token ON users(apple_app_account_token)"
  );
  // Apple app-account tokens are compared case-insensitively. An expression
  // index keeps that ownership lookup indexed and fails closed if a legacy
  // database somehow contains ambiguous mixed-case duplicates.
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_app_account_token_normalized ON users(lower(apple_app_account_token))"
  );
}

async function migrateAccountDeletionColumns(db) {
  const columns = await db.all("PRAGMA table_info(account_deletions)");
  if (columns.length === 0) return;
  const existingColumnNames = new Set(columns.map((column) => column.name));
  for (const migration of ACCOUNT_DELETION_COLUMN_MIGRATIONS) {
    if (!existingColumnNames.has(migration.name)) {
      await db.exec(migration.sql);
    }
  }
}

async function readDatabaseSchemaVersion(db) {
  const versionRow = await db.get("PRAGMA user_version");
  return Number(versionRow?.user_version || 0);
}

function assertSupportedSchemaVersion(version) {
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is newer than supported version ${DATABASE_SCHEMA_VERSION}.`
    );
  }
}

async function configureOperationalPragmas(db) {
  // journal_mode cannot be changed from inside a transaction. Compatibility is
  // checked before this call so an older binary never mutates a newer database.
  await db.exec("PRAGMA journal_mode = WAL");
  // foreign_keys is connection-local and is also a no-op inside a transaction.
  await db.exec("PRAGMA foreign_keys = ON");
}

function schemaDdlOnly(schema) {
  // Keep schema.sql convenient for direct test/development bootstraps while
  // ensuring production initialization runs connection PRAGMAs outside the
  // atomic DDL transaction.
  return schema
    .replace(
      /^[ \t]*PRAGMA[ \t]+journal_mode[ \t]*=[ \t]*WAL[ \t]*;[ \t]*(?:\r?\n)?/gim,
      ""
    )
    .replace(
      /^[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*ON[ \t]*;[ \t]*(?:\r?\n)?/gim,
      ""
    );
}

export async function applyDatabaseSchema(db, schema) {
  const preflightVersion = await readDatabaseSchemaVersion(db);
  assertSupportedSchemaVersion(preflightVersion);

  await configureOperationalPragmas(db);
  await db.exec("BEGIN IMMEDIATE");
  try {
    // Recheck while holding the write lock in case another process migrated
    // between the read-only preflight and BEGIN IMMEDIATE.
    const lockedVersion = await readDatabaseSchemaVersion(db);
    assertSupportedSchemaVersion(lockedVersion);

    // Upgrade columns on existing tables before applying the current schema.
    // Current indexes may reference those columns, and CREATE TABLE IF NOT
    // EXISTS does not alter an older table definition.
    await migrateUserSubscriptionColumns(db);
    await migrateAccountDeletionColumns(db);
    await db.exec(schemaDdlOnly(schema));
    // Fresh databases did not have tables during the pre-schema migration;
    // this second pass also keeps migration-owned indexes authoritative.
    await migrateUserSubscriptionColumns(db);
    await migrateAccountDeletionColumns(db);
    await db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function initDb() {
  const db = await getDb();

  const schema = fs.readFileSync(SCHEMA_URL, "utf-8");

  await applyDatabaseSchema(db, schema);

  console.log("✅ Database schema initialized");
}
