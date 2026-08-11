import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

import {
  closeDb,
  getDb,
  resetDbForTests,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../src/db/db.js";
import {
  applyDatabaseSchema,
  DATABASE_SCHEMA_VERSION,
  initDb,
} from "../src/db/initDb.js";

async function readSchema() {
  return fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
}

function versionOneSchema(schema) {
  return schema
    .replace(
      /^\s*firebase_deletion_attempts INTEGER NOT NULL DEFAULT 0,\s*\r?\n/m,
      ""
    )
    .replace(/^\s*firebase_next_retry_at INTEGER,\s*\r?\n/m, "")
    .replace(
      /^CREATE INDEX IF NOT EXISTS idx_account_deletions_firebase_recovery\s*\r?\n\s*ON account_deletions\(status, firebase_next_retry_at, updated_at\);\s*\r?\n/m,
      ""
    );
}

async function schemaSnapshot(db) {
  return db.all(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`
  );
}

test("database initialization is CWD-independent and configures lock waiting", async (t) => {
  const originalCwd = process.cwd();
  const originalSqlitePath = process.env.SQLITE_PATH;
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mobilesearcher-db-")
  );
  const alternateCwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "mobilesearcher-cwd-")
  );
  process.env.SQLITE_PATH = path.join(tempDirectory, "database.sqlite");

  t.after(async () => {
    process.chdir(originalCwd);
    await resetDbForTests();
    if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = originalSqlitePath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
    await fs.rm(alternateCwd, { recursive: true, force: true });
  });

  process.chdir(alternateCwd);
  await initDb();
  const db = await getDb();
  const busyTimeout = await db.get("PRAGMA busy_timeout");
  const journalMode = await db.get("PRAGMA journal_mode");
  const foreignKeys = await db.get("PRAGMA foreign_keys");
  const schemaVersion = await db.get("PRAGMA user_version");
  const usersTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  );

  assert.equal(busyTimeout.timeout, SQLITE_BUSY_TIMEOUT_MS);
  assert.equal(journalMode.journal_mode, "wal");
  assert.equal(foreignKeys.foreign_keys, 1);
  assert.equal(schemaVersion.user_version, DATABASE_SCHEMA_VERSION);
  assert.equal(usersTable.name, "users");

  const firstClose = closeDb();
  const secondClose = closeDb();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  await closeDb();
});

test("a newer database is rejected before schema or journal mutation", async (t) => {
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mobilesearcher-newer-db-")
  );
  const databasePath = path.join(tempDirectory, "newer.sqlite");
  const db = await open({ filename: databasePath, driver: sqlite3.Database });
  t.after(async () => {
    await db.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  await db.exec(`
    CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sentinel (value) VALUES ('unchanged');
    PRAGMA user_version = ${DATABASE_SCHEMA_VERSION + 1};
  `);
  const schemaBefore = await schemaSnapshot(db);
  const journalBefore = await db.get("PRAGMA journal_mode");

  await assert.rejects(
    applyDatabaseSchema(db, await readSchema()),
    /newer than supported/
  );

  assert.deepEqual(await schemaSnapshot(db), schemaBefore);
  assert.deepEqual(await db.get("PRAGMA journal_mode"), journalBefore);
  assert.deepEqual(await db.get("PRAGMA user_version"), {
    user_version: DATABASE_SCHEMA_VERSION + 1,
  });
  assert.deepEqual(await db.all("SELECT value FROM sentinel"), [
    { value: "unchanged" },
  ]);
});

test("schema DDL and legacy column migrations roll back together", async (t) => {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE users (
      uid TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      apple_app_account_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (
      uid, username, apple_app_account_token, created_at, updated_at
    ) VALUES
      ('first', 'first', 'Mixed-Case-Token', 1, 1),
      ('second', 'second', 'mixed-case-token', 1, 1);
  `);
  const schemaBefore = await schemaSnapshot(db);

  await assert.rejects(
    applyDatabaseSchema(db, await readSchema()),
    /UNIQUE constraint failed/
  );

  assert.deepEqual(await schemaSnapshot(db), schemaBefore);
  assert.deepEqual(await db.get("PRAGMA user_version"), { user_version: 0 });
  assert.deepEqual(
    (await db.all("PRAGMA table_info(users)")).map((column) => column.name),
    [
      "uid",
      "username",
      "apple_app_account_token",
      "created_at",
      "updated_at",
    ]
  );
});

test("version 1 deletion tombstones gain durable Firebase retry metadata", async (t) => {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());

  const schema = await readSchema();
  await db.exec(versionOneSchema(schema));
  await db.exec("PRAGMA user_version = 1");
  await db.run(
    `INSERT INTO account_deletions (
       firebase_uid, status, firebase_status, local_data_status,
       apple_identity_linked, apple_revocation_status,
       apple_revocation_attempts, requested_at, updated_at
     ) VALUES (?, 'processing', 'pending', 'deleted', 0, 'not_linked', 0, ?, ?)`,
    ["legacy-delete", 1_000, 1_000]
  );

  await applyDatabaseSchema(db, schema);

  assert.deepEqual(await db.get("PRAGMA user_version"), {
    user_version: DATABASE_SCHEMA_VERSION,
  });
  assert.deepEqual(
    await db.get(
      `SELECT firebase_deletion_attempts, firebase_next_retry_at
         FROM account_deletions
        WHERE firebase_uid = ?`,
      ["legacy-delete"]
    ),
    {
      firebase_deletion_attempts: 0,
      firebase_next_retry_at: null,
    }
  );
});
