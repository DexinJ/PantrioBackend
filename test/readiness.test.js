import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDraining,
  inspectReadiness,
  resetReadinessForTests,
} from "../src/operations/readiness.js";

test.afterEach(() => resetReadinessForTests());

test("readiness verifies SQLite and fails closed during drain", async () => {
  let queries = 0;
  const getDbFn = async () => ({
    async get(sql) {
      queries += 1;
      assert.equal(sql, "SELECT 1 AS ready");
      return { ready: 1 };
    },
  });

  assert.deepEqual(await inspectReadiness({ getDbFn }), {
    ok: true,
    status: 200,
  });
  assert.equal(queries, 1);

  beginDraining();
  const draining = await inspectReadiness({ getDbFn });
  assert.equal(draining.status, 503);
  assert.equal(draining.code, "SERVER_DRAINING");
  assert.equal(queries, 1);
});

test("readiness returns 503 when SQLite cannot answer", async () => {
  const result = await inspectReadiness({
    getDbFn: async () => {
      throw new Error("disk unavailable");
    },
  });

  assert.equal(result.status, 503);
  assert.equal(result.code, "DATABASE_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("disk unavailable"), false);
});
