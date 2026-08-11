import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { AppleSignInError } from "../src/auth/appleSignInService.js";
import {
  assertRecentAccountAuthentication,
  requestAccountDeletion,
  resumeAccountDeletion,
  resumePendingAccountDeletions,
} from "../src/accountDeletion/accountDeletionService.js";
import {
  createAccountDeletion,
  getAccountDeletion,
  listProcessingAccountDeletions,
} from "../src/accountDeletion/accountDeletionStore.js";
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

async function seedUserData(db, { withAppleCredential = false } = {}) {
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  await db.run(
    `INSERT INTO usage_daily (
       owner_type, owner_key, day_key, tokens_used, requests, updated_at
     ) VALUES ('user', 'firebase-user', '2026-08-10', 10, 1, 1)`
  );
  const conversation = await db.run(
    `INSERT INTO conversations (owner_type, owner_key, model, language, created_at)
     VALUES ('user', 'firebase-user', 'gpt-5-mini', 'en', 1)`
  );
  await db.run(
    `INSERT INTO messages (conversation_id, role, content, created_at)
     VALUES (?, 'user', 'private history', 1)`,
    [conversation.lastID]
  );
  if (withAppleCredential) {
    await db.run(
      `INSERT INTO apple_sign_in_credentials (
         firebase_uid, apple_subject, client_id, encrypted_refresh_token,
         created_at, updated_at
       ) VALUES ('firebase-user', 'apple-subject', 'com.chilltech.pantrio',
                 'encrypted-token', 1, 1)`
    );
  }
}

test("recent account deletion authentication is provider-neutral", () => {
  assert.doesNotThrow(() =>
    assertRecentAccountAuthentication(
      {
        auth_time: 9_500,
        firebase: { sign_in_provider: "password" },
      },
      { nowSeconds: 10_000 }
    )
  );
  assert.throws(
    () =>
      assertRecentAccountAuthentication(
        {
          auth_time: 9_000,
          firebase: { sign_in_provider: "google.com" },
        },
        { nowSeconds: 10_000 }
      ),
    (error) =>
      error.code === "RECENT_AUTH_REQUIRED" &&
      error.details.maxAgeSeconds === 600
  );
});

test("durably completes deletion, revokes Apple, and purges legacy chat", async (t) => {
  const db = await openDb(t);
  await seedUserData(db, { withAppleCredential: true });
  let firebaseDeletes = 0;
  let appleRevocations = 0;

  const options = {
    uid: "firebase-user",
    appleIdentityLinked: true,
    nowFn: () => 1_700_000_000_000,
    deleteFirebaseUserFn: async () => {
      firebaseDeletes += 1;
    },
    revokeAppleCredentialFn: async ({ uid, credential }) => {
      appleRevocations += 1;
      assert.equal(uid, "firebase-user");
      assert.equal(credential.encrypted_refresh_token, "encrypted-token");
    },
  };

  const first = await requestAccountDeletion(db, options);
  const second = await requestAccountDeletion(db, options);

  assert.equal(first.deletionStatus, "complete");
  assert.equal(first.appleSignInRevocation, "revoked");
  assert.deepEqual(second, first);
  assert.equal(firebaseDeletes, 1);
  assert.equal(appleRevocations, 1);
  assert.equal(await db.get("SELECT 1 FROM users"), undefined);
  assert.equal(await db.get("SELECT 1 FROM usage_daily"), undefined);
  assert.equal(await db.get("SELECT 1 FROM conversations"), undefined);
  assert.equal(await db.get("SELECT 1 FROM messages"), undefined);
  assert.equal(
    (await getAccountDeletion(db, "firebase-user")).encrypted_apple_refresh_token,
    null
  );
  assert.equal(
    (await getAccountDeletion(db, "firebase-user")).apple_revocation_attempts,
    1
  );
});

test("keeps retryable Apple credentials in the tombstone after user purge", async (t) => {
  const db = await openDb(t);
  await seedUserData(db, { withAppleCredential: true });
  let nowMs = 1_700_000_000_000;

  const first = await requestAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: true,
    nowFn: () => nowMs,
    deleteFirebaseUserFn: async () => {},
    revokeAppleCredentialFn: async () => {
      throw new AppleSignInError("APPLE_SERVICE_UNAVAILABLE", "temporary", {
        status: 503,
        retryable: true,
      });
    },
  });
  const pending = await getAccountDeletion(db, "firebase-user");

  assert.equal(first.deletionStatus, "processing");
  assert.equal(first.appleSignInRevocation, "pending");
  assert.equal(first.firebaseStatus, "deleted");
  assert.equal(first.localDataStatus, "deleted");
  assert.equal(pending.encrypted_apple_refresh_token, "encrypted-token");
  assert.equal(await db.get("SELECT 1 FROM users"), undefined);

  nowMs = pending.apple_next_retry_at;
  const completed = await resumeAccountDeletion(db, {
    uid: "firebase-user",
    nowFn: () => nowMs,
    deleteFirebaseUserFn: async () => {
      throw new Error("Firebase deletion must not repeat");
    },
    revokeAppleCredentialFn: async ({ credential }) => {
      assert.equal(credential.encrypted_refresh_token, "encrypted-token");
    },
  });

  assert.equal(completed.deletionStatus, "complete");
  assert.equal(completed.appleSignInRevocation, "revoked");
  assert.equal(
    (await getAccountDeletion(db, "firebase-user")).apple_revocation_attempts,
    2
  );
});

test("purges local data while Firebase deletion is pending, then resumes", async (t) => {
  const db = await openDb(t);
  await seedUserData(db);
  let firebaseAvailable = false;
  let nowMs = 1_700_000_000_000;

  const dependencies = {
    uid: "firebase-user",
    nowFn: () => nowMs,
    deleteFirebaseUserFn: async () => {
      if (!firebaseAvailable) {
        nowMs += 25_000;
        const error = new Error("network unavailable");
        error.code = "app/network-error";
        throw error;
      }
    },
    revokeAppleCredentialFn: async () => {},
  };

  const pending = await requestAccountDeletion(db, dependencies);
  assert.equal(pending.deletionStatus, "processing");
  assert.equal(pending.firebaseStatus, "pending");
  assert.equal(pending.localDataStatus, "deleted");
  assert.equal(await db.get("SELECT 1 FROM users"), undefined);
  assert.equal(
    (await getAccountDeletion(db, "firebase-user")).firebase_next_retry_at,
    nowMs + 5_000
  );

  firebaseAvailable = true;
  const deferred = await resumeAccountDeletion(db, dependencies);
  assert.equal(deferred.deletionStatus, "processing");
  nowMs = (await getAccountDeletion(db, "firebase-user")).firebase_next_retry_at;
  const completed = await resumeAccountDeletion(db, dependencies);
  assert.equal(completed.deletionStatus, "complete");
  assert.equal(completed.firebaseStatus, "deleted");
});

test("persists terminal Apple manual action independently of the user row", async (t) => {
  const db = await openDb(t);
  await seedUserData(db, { withAppleCredential: true });

  const result = await requestAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: true,
    deleteFirebaseUserFn: async () => {},
    revokeAppleCredentialFn: async () => {
      const error = new Error("configuration missing");
      error.code = "APPLE_SIGN_IN_NOT_CONFIGURED";
      throw error;
    },
  });

  assert.equal(result.deletionStatus, "complete");
  assert.equal(result.appleSignInRevocation, "manual_required");
  assert.equal(
    (await getAccountDeletion(db, "firebase-user")).apple_revocation_status,
    "manual_required"
  );
});

test("a deletion tombstone prevents profile reprovisioning", async (t) => {
  const db = await openDb(t);
  await createAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: false,
  });

  await assert.rejects(
    ensureUserProfile(db, { uid: "firebase-user", email: "user@example.com" }),
    (error) => error.code === "ACCOUNT_DELETION_IN_PROGRESS"
  );
  assert.equal(await db.get("SELECT 1 FROM users"), undefined);

  await assert.rejects(
    db.run(
      `INSERT INTO users (uid, username, created_at, updated_at)
       VALUES ('firebase-user', 'recreated', 1, 1)`
    ),
    /ACCOUNT_DELETION_BLOCKED/
  );
  await assert.rejects(
    db.run(
      `INSERT INTO usage_daily (
         owner_type, owner_key, day_key, tokens_used, requests, updated_at
       ) VALUES ('user', 'firebase-user', '2026-08-10', 1, 1, 1)`
    ),
    /ACCOUNT_DELETION_BLOCKED/
  );
  await assert.rejects(
    db.run(
      `INSERT INTO conversations (
         owner_type, owner_key, model, language, created_at
       ) VALUES ('user', 'firebase-user', 'gpt-5-mini', 'en', 1)`
    ),
    /ACCOUNT_DELETION_BLOCKED/
  );
});

test("recovery batching skips future Apple-only retries without starving ready work", async (t) => {
  const db = await openDb(t);
  await createAccountDeletion(db, {
    uid: "future-apple",
    appleIdentityLinked: true,
    nowMs: 1,
  });
  await db.run(
    `UPDATE account_deletions
        SET firebase_status = 'deleted', local_data_status = 'deleted',
            apple_revocation_status = 'pending', apple_next_retry_at = 2000
      WHERE firebase_uid = 'future-apple'`
  );
  await createAccountDeletion(db, {
    uid: "ready-firebase",
    appleIdentityLinked: false,
    nowMs: 2,
  });

  assert.deepEqual(
    await listProcessingAccountDeletions(db, { nowMs: 1_000, limit: 25 }),
    [{ firebase_uid: "ready-firebase" }]
  );
  assert.deepEqual(
    await listProcessingAccountDeletions(db, { nowMs: 2_000, limit: 25 }),
    [
      { firebase_uid: "future-apple" },
      { firebase_uid: "ready-firebase" },
    ]
  );
});

test("recovery uses bounded concurrency while preserving durable completion", async (t) => {
  const db = await openDb(t);
  for (const uid of ["recovery-a", "recovery-b", "recovery-c"]) {
    await createAccountDeletion(db, {
      uid,
      appleIdentityLinked: false,
      nowMs: 1,
    });
  }

  let activeDeletes = 0;
  let maximumActiveDeletes = 0;
  const results = await resumePendingAccountDeletions(db, {
    batchSize: 3,
    concurrency: 2,
    async deleteFirebaseUserFn() {
      activeDeletes += 1;
      maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeDeletes -= 1;
    },
    nowFn: () => 2,
  });

  assert.equal(maximumActiveDeletes, 2);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.deletionStatus === "complete"));
});
