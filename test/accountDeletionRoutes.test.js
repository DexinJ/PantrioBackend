import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { attachAccountDeletionRoutes } from "../src/accountDeletion/accountDeletionRoutes.js";
import { createAccountDeletion } from "../src/accountDeletion/accountDeletionStore.js";

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

async function startRoutes(t, dependencies) {
  const app = express();
  app.use(express.json());
  attachAccountDeletionRoutes(app, dependencies);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function authHeaders(token = "deletion-token") {
  return { Authorization: `Bearer ${token}` };
}

test("DELETE requires recent authentication without requiring Apple", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  let deleteCalls = 0;
  const decoded = {
    uid: "firebase-user",
    auth_time: 9_000,
    firebase: { sign_in_provider: "password" },
  };
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => decoded,
    getFirebaseUserFn: async () => ({ providerData: [] }),
    deleteFirebaseUserFn: async () => {
      deleteCalls += 1;
    },
    nowFn: () => 10_000_000,
  });

  const response = await fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.code, "RECENT_AUTH_REQUIRED");
  assert.equal(payload.maxAgeSeconds, 600);
  assert.equal(deleteCalls, 0);
});

test("DELETE and deletion-status are UID-scoped and idempotent after Firebase removal", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  const decoded = {
    uid: "firebase-user",
    auth_time: 9_950,
    firebase: { sign_in_provider: "password" },
  };
  let activeVerificationCalls = 0;
  let firebaseDeletes = 0;
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => {
      activeVerificationCalls += 1;
      if (activeVerificationCalls > 1) {
        throw new Error("deleted Firebase user must not be reverified");
      }
      return decoded;
    },
    getFirebaseUserFn: async () => ({ providerData: [] }),
    deleteFirebaseUserFn: async () => {
      firebaseDeletes += 1;
    },
    nowFn: () => 10_000_000,
  });

  const first = await fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const firstPayload = await first.json();
  const repeated = await fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const status = await fetch(
    `${baseUrl}/api/users/firebase-user/deletion-status`,
    { headers: authHeaders() }
  );

  assert.equal(first.status, 200);
  assert.equal(firstPayload.deletionStatus, "complete");
  assert.equal(firstPayload.firebaseStatus, "deleted");
  assert.equal(firstPayload.localDataStatus, "deleted");
  assert.equal(firstPayload.appleSignInRevocation, "not_linked");
  assert.equal(repeated.status, 200);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).deletionStatus, "complete");
  assert.equal(activeVerificationCalls, 1);
  assert.equal(firebaseDeletes, 1);

  const mismatch = await fetch(`${baseUrl}/api/users/different/deletion-status`, {
    headers: authHeaders(),
  });
  assert.equal(mismatch.status, 403);
});

test("durably accepted deletion returns 202 while Firebase cleanup retries", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  const decoded = {
    uid: "firebase-user",
    auth_time: 9_950,
    firebase: { sign_in_provider: "google.com" },
  };
  let firebaseDeletionCalls = 0;
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => decoded,
    getFirebaseUserFn: async () => ({ providerData: [] }),
    deleteFirebaseUserFn: async () => {
      firebaseDeletionCalls += 1;
      const error = new Error("Firebase unavailable");
      error.code = "app/network-error";
      throw error;
    },
    nowFn: () => 10_000_000,
  });

  const response = await fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const payload = await response.json();

  assert.equal(response.status, 202);
  assert.equal(payload.ok, false);
  assert.equal(payload.retryable, true);
  assert.equal(payload.deletionStatus, "processing");
  assert.equal(payload.firebaseStatus, "pending");
  assert.equal(payload.localDataStatus, "deleted");
  const statusResponses = await Promise.all([
    fetch(`${baseUrl}/api/users/firebase-user/deletion-status`, {
      headers: authHeaders(),
    }),
    fetch(`${baseUrl}/api/users/firebase-user/deletion-status`, {
      headers: authHeaders(),
    }),
  ]);
  assert.deepEqual(statusResponses.map(({ status }) => status), [202, 202]);
  assert.equal(firebaseDeletionCalls, 1);
});

test("deletion-status distinguishes an active account with no request", async (t) => {
  const db = await openDb(t);
  const decoded = { uid: "firebase-user", auth_time: 1 };
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => decoded,
    getFirebaseUserFn: async () => ({ uid: "firebase-user" }),
  });

  const response = await fetch(
    `${baseUrl}/api/users/firebase-user/deletion-status`,
    { headers: authHeaders() }
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.deletionStatus, "not_requested");
  assert.equal(payload.firebaseStatus, "active");
});

test("deletion-status requires an active session when no tombstone exists", async (t) => {
  const db = await openDb(t);
  const decoded = { uid: "firebase-user", auth_time: 1 };
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => {
      throw new Error("revoked token");
    },
    getFirebaseUserFn: async () => {
      throw new Error("Firebase lookup must not run");
    },
  });

  const response = await fetch(
    `${baseUrl}/api/users/firebase-user/deletion-status`,
    { headers: authHeaders() }
  );
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "AUTH_INVALID");
});

test("a concurrently created tombstone makes DELETE reconciliation idempotent", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  const decoded = {
    uid: "firebase-user",
    auth_time: 9_950,
    firebase: { sign_in_provider: "password" },
  };
  let firebaseDeletes = 0;
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async () => {
      await createAccountDeletion(db, {
        uid: decoded.uid,
        appleIdentityLinked: false,
        nowMs: 10_000_000,
      });
      const error = new Error("Firebase user was deleted concurrently");
      error.code = "auth/user-not-found";
      throw error;
    },
    deleteFirebaseUserFn: async () => {
      firebaseDeletes += 1;
      const error = new Error("already removed");
      error.code = "auth/user-not-found";
      throw error;
    },
    nowFn: () => 10_000_000,
  });

  const response = await fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.deletionStatus, "complete");
  assert.equal(payload.firebaseStatus, "deleted");
  assert.equal(firebaseDeletes, 1);
});

test("deletion-status serializes not-requested with a concurrent DELETE", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  const decoded = {
    uid: "firebase-user",
    auth_time: 9_950,
    firebase: { sign_in_provider: "password" },
  };
  let releaseStatusVerification;
  const statusVerificationGate = new Promise((resolve) => {
    releaseStatusVerification = resolve;
  });
  let markStatusStarted;
  const statusStarted = new Promise((resolve) => {
    markStatusStarted = resolve;
  });
  let markDeleteVerified;
  const deleteVerified = new Promise((resolve) => {
    markDeleteVerified = resolve;
  });
  let firebaseDeletes = 0;
  const baseUrl = await startRoutes(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => decoded,
    verifyActiveTokenFn: async (token) => {
      if (token === "status-token") {
        markStatusStarted();
        await statusVerificationGate;
      } else {
        markDeleteVerified();
      }
      return decoded;
    },
    getFirebaseUserFn: async () => ({ providerData: [] }),
    deleteFirebaseUserFn: async () => {
      firebaseDeletes += 1;
    },
    nowFn: () => 10_000_000,
  });

  const statusPromise = fetch(
    `${baseUrl}/api/users/firebase-user/deletion-status`,
    { headers: authHeaders("status-token") }
  );
  await statusStarted;

  const deletionPromise = fetch(`${baseUrl}/api/users/firebase-user`, {
    method: "DELETE",
    headers: authHeaders("delete-token"),
  });
  await deleteVerified;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firebaseDeletes, 0);
  assert.equal(
    await db.get(
      "SELECT 1 FROM account_deletions WHERE firebase_uid = 'firebase-user'"
    ),
    undefined
  );

  releaseStatusVerification();
  const statusResponse = await statusPromise;
  const statusPayload = await statusResponse.json();
  const deletionResponse = await deletionPromise;
  const deletionPayload = await deletionResponse.json();

  assert.equal(statusPayload.deletionStatus, "not_requested");
  assert.equal(deletionPayload.deletionStatus, "complete");
  assert.equal(firebaseDeletes, 1);
});
