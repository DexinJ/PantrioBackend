// src/db/db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { resolveSqlitePath } from "../config/runtimeConfig.js";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

// single shared connection
let dbPromise = null;
let dbClosePromise = null;
let dbTerminallyClosed = false;
const losAngelesDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function databaseShuttingDownError() {
  const error = new Error("The database is shutting down");
  error.code = "DATABASE_SHUTTING_DOWN";
  return error;
}

export async function getDb() {
  if (dbTerminallyClosed) throw databaseShuttingDownError();
  if (dbClosePromise) await dbClosePromise;
  if (dbTerminallyClosed) throw databaseShuttingDownError();

  if (!dbPromise) {
    const pendingOpen = (async () => {
      const db = await open({
        filename: resolveSqlitePath(process.env),
        driver: sqlite3.Database,
      });
      try {
        await db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
      return db;
    })();

    dbPromise = pendingOpen;
    void pendingOpen.catch(() => {
      if (dbPromise === pendingOpen) dbPromise = null;
    });
  }

  return dbPromise;
}

export function closeDb({ checkpoint = true, terminal = false } = {}) {
  if (terminal) dbTerminallyClosed = true;
  if (dbClosePromise) return dbClosePromise;
  if (!dbPromise) return Promise.resolve();

  const pendingDb = dbPromise;
  let didClose = false;
  dbClosePromise = (async () => {
    const db = await pendingDb;
    let checkpointError = null;

    if (checkpoint) {
      try {
        await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        checkpointError = error;
      }
    }

    try {
      await db.close();
      didClose = true;
    } catch (closeError) {
      if (checkpointError) {
        throw new AggregateError(
          [checkpointError, closeError],
          "SQLite checkpoint and close both failed"
        );
      }
      throw closeError;
    }

    if (checkpointError) throw checkpointError;
  })().finally(() => {
    if (didClose && dbPromise === pendingDb) dbPromise = null;
    dbClosePromise = null;
  });

  return dbClosePromise;
}

export async function resetDbForTests() {
  try {
    await closeDb({ checkpoint: false });
  } finally {
    dbTerminallyClosed = false;
  }
}

/**
 * Returns YYYY-MM-DD in America/Los_Angeles day boundary.
 * Uses Intl without extra deps.
 */
export function dayKeyLA(date = new Date()) {
  // en-CA formats like YYYY-MM-DD
  return losAngelesDayFormatter.format(date);
}
