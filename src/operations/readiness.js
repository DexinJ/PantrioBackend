import { getDb } from "../db/db.js";

let draining = false;

export function beginDraining() {
  draining = true;
}

export function resetReadinessForTests() {
  draining = false;
}

export async function inspectReadiness({ getDbFn = getDb } = {}) {
  if (draining) {
    return {
      ok: false,
      status: 503,
      code: "SERVER_DRAINING",
      error: "The server is shutting down.",
    };
  }

  try {
    const db = await getDbFn();
    const result = await db.get("SELECT 1 AS ready");
    if (result?.ready !== 1) throw new Error("SQLite readiness query failed");
    return { ok: true, status: 200 };
  } catch {
    return {
      ok: false,
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      error: "The database is unavailable.",
    };
  }
}
