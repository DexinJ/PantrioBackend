import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { inspect } from "node:util";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { createAccountDeletion } from "../src/accountDeletion/accountDeletionStore.js";
import {
  requireAuthenticatedUser,
  sendAccountDeletionRaceResponse,
} from "../src/http/routes.js";
import { ensureUserProfile } from "../src/session/sessionService.js";

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

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("HTTP authentication returns the tombstone before checking Firebase revocation", async (t) => {
  const db = await openDb(t);
  await createAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: false,
    nowMs: 1_700_000_000_000,
  });
  const res = responseRecorder();
  let activeVerifications = 0;

  const decoded = await requireAuthenticatedUser(
    { headers: { authorization: "Bearer cached-token" } },
    res,
    {
      getDbFn: async () => db,
      verifySignedTokenFn: async () => ({ uid: "firebase-user" }),
      verifyActiveTokenFn: async () => {
        activeVerifications += 1;
        throw new Error("deleted Firebase user");
      },
    }
  );

  assert.equal(decoded, null);
  assert.equal(activeVerifications, 0);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.code, "ACCOUNT_DELETION_IN_PROGRESS");
  assert.equal(res.body.deletionStatus, "processing");
});

test("HTTP authentication still requires an active Firebase session without a tombstone", async (t) => {
  const db = await openDb(t);
  const res = responseRecorder();
  const calls = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });

  const decoded = await requireAuthenticatedUser(
    { headers: { authorization: "Bearer revoked-token" } },
    res,
    {
      getDbFn: async () => db,
      verifySignedTokenFn: async () => {
        calls.push("signed");
        return { uid: "firebase-user" };
      },
      verifyActiveTokenFn: async () => {
        calls.push("active");
        throw new Error("revoked token");
      },
    }
  );

  assert.equal(decoded, null);
  assert.deepEqual(calls, ["signed", "active"]);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "AUTH_INVALID");
});

test("late deletion races return safe 410 responses without leaking Apple credentials", async (t) => {
  const db = await openDb(t);
  const encryptedCredential = "encrypted-refresh-token-must-stay-private";
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  await db.run(
    `INSERT INTO apple_sign_in_credentials (
       firebase_uid, apple_subject, client_id, encrypted_refresh_token,
       created_at, updated_at
     ) VALUES ('firebase-user', 'apple-subject', 'com.chilltech.pantrio', ?, 1, 1)`,
    [encryptedCredential]
  );
  await createAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: true,
    nowMs: 1_700_000_000_000,
  });

  let profileError;
  await assert.rejects(
    ensureUserProfile(db, { uid: "firebase-user" }),
    (error) => {
      profileError = error;
      return error.code === "ACCOUNT_DELETION_IN_PROGRESS";
    }
  );
  assert.equal("deletion" in profileError, false);
  assert.doesNotMatch(inspect(profileError), new RegExp(encryptedCredential));

  const logs = [];
  const res = responseRecorder();
  const handled = await sendAccountDeletionRaceResponse(res, {
    uid: "firebase-user",
    db,
    error: profileError,
    context: "[test deletion race]",
    logFn: (...args) => logs.push(args),
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.code, "ACCOUNT_DELETION_IN_PROGRESS");
  assert.equal(res.body.appleSignInRevocation, "pending");
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(encryptedCredential));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(encryptedCredential));

  let triggerError;
  await assert.rejects(
    db.run(
      `INSERT INTO users (uid, username, created_at, updated_at)
       VALUES ('firebase-user', 'racing-write', 2, 2)`
    ),
    (error) => {
      triggerError = error;
      return String(error.message).includes("ACCOUNT_DELETION_BLOCKED");
    }
  );
  const triggerRes = responseRecorder();
  assert.equal(
    await sendAccountDeletionRaceResponse(triggerRes, {
      uid: "firebase-user",
      db,
      error: triggerError,
      logFn: (...args) => logs.push(args),
    }),
    true
  );
  assert.equal(triggerRes.statusCode, 410);
  assert.equal(triggerRes.body.code, "ACCOUNT_DELETION_IN_PROGRESS");
  assert.doesNotMatch(
    JSON.stringify({ logs, body: triggerRes.body }),
    new RegExp(encryptedCredential)
  );
});
