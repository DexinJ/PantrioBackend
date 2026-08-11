import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseNodeEnvironment,
  parsePort,
  requireNodeEnvironment,
  resolveSqlitePath,
  validateFirebaseCredentialSources,
  validateSingleReplicaEnvironment,
} from "../src/config/runtimeConfig.js";

test("runtime environment and port validation reject silent unsafe fallbacks", () => {
  assert.equal(parseNodeEnvironment(undefined), "development");
  assert.equal(parseNodeEnvironment("PRODUCTION"), "production");
  assert.throws(() => parseNodeEnvironment("prodution"), /NODE_ENV/);
  assert.equal(requireNodeEnvironment(" TEST "), "test");
  for (const value of [undefined, null, "", "   "]) {
    assert.throws(() => requireNodeEnvironment(value), /NODE_ENV is required/);
  }
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort("8080"), 8080);
  for (const value of ["0", "65536", "3.5", "not-a-port"]) {
    assert.throws(() => parsePort(value), /PORT/);
  }
});

test("startup config requires an explicit environment and production replica count", (t) => {
  const workingDirectory = mkdtempSync(
    path.join(os.tmpdir(), "backend-runtime-config-")
  );
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));

  const configUrl = new URL("../src/config/env.js", import.meta.url).href;
  const loadConfig = (overrides = {}) => {
    const environment = {
      ...process.env,
      OPENAI_API_KEY: "test-openai-key",
      ...overrides,
    };
    for (const name of [
      "NODE_ENV",
      "BACKEND_REPLICA_COUNT",
      "WEB_CONCURRENCY",
    ]) {
      if (environment[name] === undefined) delete environment[name];
    }
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(configUrl)})`,
      ],
      { cwd: workingDirectory, env: environment, encoding: "utf8" }
    );
  };

  const missingEnvironment = loadConfig({
    NODE_ENV: undefined,
    BACKEND_REPLICA_COUNT: undefined,
    WEB_CONCURRENCY: undefined,
  });
  assert.notEqual(missingEnvironment.status, 0);
  assert.match(missingEnvironment.stderr, /NODE_ENV is required/);

  const missingReplicaCount = loadConfig({
    NODE_ENV: "production",
    BACKEND_REPLICA_COUNT: undefined,
    WEB_CONCURRENCY: undefined,
  });
  assert.notEqual(missingReplicaCount.status, 0);
  assert.match(missingReplicaCount.stderr, /BACKEND_REPLICA_COUNT=1/);

  const unsafeWebConcurrency = loadConfig({
    NODE_ENV: "production",
    BACKEND_REPLICA_COUNT: "1",
    WEB_CONCURRENCY: "2",
  });
  assert.notEqual(unsafeWebConcurrency.status, 0);
  assert.match(unsafeWebConcurrency.stderr, /WEB_CONCURRENCY must be 1/);

  const safeProductionConfig = loadConfig({
    NODE_ENV: "production",
    BACKEND_REPLICA_COUNT: "1",
    WEB_CONCURRENCY: "1",
  });
  assert.equal(safeProductionConfig.status, 0, safeProductionConfig.stderr);
});

test("production requires an absolute SQLite path and a single replica", () => {
  assert.throws(
    () => resolveSqlitePath({ NODE_ENV: "production", SQLITE_PATH: "data.sqlite" }),
    /absolute path/
  );
  const absolutePath = path.resolve("persistent", "data.sqlite");
  assert.equal(
    resolveSqlitePath({ NODE_ENV: "production", SQLITE_PATH: absolutePath }),
    absolutePath
  );
  assert.throws(
    () =>
      validateSingleReplicaEnvironment({
        NODE_ENV: "production",
      }),
    /BACKEND_REPLICA_COUNT=1/
  );
  assert.throws(
    () =>
      validateSingleReplicaEnvironment({
        NODE_ENV: "production",
        BACKEND_REPLICA_COUNT: "2",
      }),
    /BACKEND_REPLICA_COUNT=1/
  );
  assert.throws(
    () =>
      validateSingleReplicaEnvironment({
        NODE_ENV: "production",
        BACKEND_REPLICA_COUNT: "1.0",
      }),
    /BACKEND_REPLICA_COUNT=1/
  );
  assert.throws(
    () =>
      validateSingleReplicaEnvironment({
        NODE_ENV: "production",
        BACKEND_REPLICA_COUNT: "1",
        WEB_CONCURRENCY: "2",
      }),
    /WEB_CONCURRENCY/
  );
  validateSingleReplicaEnvironment({
    NODE_ENV: "production",
    BACKEND_REPLICA_COUNT: "1",
    WEB_CONCURRENCY: "1",
  });
  validateSingleReplicaEnvironment({ NODE_ENV: "test" });
});

test("Firebase startup accepts exactly one credential source", () => {
  assert.equal(
    validateFirebaseCredentialSources({
      FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
    }),
    "json"
  );
  assert.equal(
    validateFirebaseCredentialSources({
      FIREBASE_SERVICE_ACCOUNT_PATH: "service-account.json",
    }),
    "path"
  );
  assert.throws(() => validateFirebaseCredentialSources({}), /exactly one/);
  assert.throws(
    () =>
      validateFirebaseCredentialSources({
        FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
        FIREBASE_SERVICE_ACCOUNT_PATH: "service-account.json",
      }),
    /exactly one/
  );
});
