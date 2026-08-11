import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, resetDbForTests } from "../src/db/db.js";

test("terminal database close rejects late reopen attempts", async (t) => {
  const originalSqlitePath = process.env.SQLITE_PATH;
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mobilesearcher-shutdown-db-")
  );
  process.env.SQLITE_PATH = path.join(tempDirectory, "database.sqlite");

  t.after(async () => {
    await resetDbForTests();
    if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = originalSqlitePath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const db = await getDb();
  await db.exec("CREATE TABLE shutdown_probe (id INTEGER PRIMARY KEY)");
  await closeDb({ checkpoint: true, terminal: true });

  await assert.rejects(getDb(), (error) => {
    assert.equal(error.code, "DATABASE_SHUTTING_DOWN");
    return true;
  });

  await resetDbForTests();
  const reopened = await getDb();
  const table = await reopened.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shutdown_probe'"
  );
  assert.equal(table.name, "shutdown_probe");
});
