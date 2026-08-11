import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import {
  AppleSubscriptionError,
  processAppleNotification,
  verifyAppleEvidenceForUser,
} from "../src/subscriptions/appleSubscriptionService.js";
import { getUserSubscription } from "../src/subscriptions/subscriptionStore.js";

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

function makeRuntime(token) {
  const transaction = {
    environment: "Sandbox",
    bundleId: "com.chilltech.pantrio",
    transactionId: "tx-latest",
    originalTransactionId: "original-1",
    productId: "com.chilltech.pantrio.subscription.monthly",
    appAccountToken: token,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    purchaseDate: Date.now() - 1_000,
    expiresDate: Date.now() + 86_400_000,
    signedDate: Date.now(),
  };
  const renewal = {
    originalTransactionId: transaction.originalTransactionId,
    autoRenewStatus: 1,
    signedDate: transaction.signedDate,
  };
  const verifier = {
    async verifyAndDecodeTransaction(signedTransactionInfo) {
      if (signedTransactionInfo === "invalid-transaction") {
        throw new Error("invalid signature");
      }
      if (signedTransactionInfo.includes("other")) {
        return {
          ...transaction,
          transactionId: "tx-other",
          originalTransactionId: "original-2",
        };
      }
      return signedTransactionInfo === "previous-purchase-transaction"
        ? { ...transaction, transactionId: "tx-previous" }
        : transaction;
    },
    async verifyAndDecodeRenewalInfo(signedRenewalInfo) {
      return signedRenewalInfo?.includes("other")
        ? { ...renewal, originalTransactionId: "original-2" }
        : renewal;
    },
    async verifyAndDecodeNotification() {
      return {
        notificationUUID: "notification-1",
        notificationType: "DID_RENEW",
        signedDate: Date.now(),
        data: {
          status: 1,
          signedTransactionInfo: "notification-transaction",
          signedRenewalInfo: "notification-renewal",
        },
      };
    },
  };
  return {
    environments: ["Sandbox"],
    verifiers: new Map([["Sandbox", verifier]]),
    apiClients: new Map([
      [
        "Sandbox",
        {
          async getAllSubscriptionStatuses(transactionId) {
            const other = transactionId === "tx-other";
            return {
              data: [
                {
                  lastTransactions: [
                    {
                      status: 1,
                      signedTransactionInfo: other
                        ? "current-other-transaction"
                        : "current-transaction",
                      signedRenewalInfo: other
                        ? "current-other-renewal"
                        : "current-renewal",
                    },
                  ],
                },
              ],
            };
          },
        },
      ],
    ]),
  };
}

test("verifies new-purchase evidence against the Firebase user's token", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES (?, 'apple-user', ?, 1, 1)`,
    ["apple-user", token]
  );
  const runtime = makeRuntime(token);
  const apiClient = runtime.apiClients.get("Sandbox");
  const getStatuses = apiClient.getAllSubscriptionStatuses.bind(apiClient);
  let statusCalls = 0;
  apiClient.getAllSubscriptionStatuses = async (...args) => {
    statusCalls += 1;
    return getStatuses(...args);
  };
  const result = await verifyAppleEvidenceForUser(db, {
    uid: "apple-user",
    appAccountToken: token,
    runtime,
    body: {
      source: "purchase",
      evidence: [
        { signedTransactionInfo: "purchase-transaction" },
        { signedTransactionInfo: "previous-purchase-transaction" },
      ],
    },
  });
  const repeated = await verifyAppleEvidenceForUser(db, {
    uid: "apple-user",
    appAccountToken: token,
    runtime,
    body: {
      source: "transaction_update",
      evidence: [{ signedTransactionInfo: "purchase-transaction" }],
    },
  });

  assert.deepEqual(result.acceptedTransactionIds, ["tx-latest", "tx-previous"]);
  assert.deepEqual(repeated.acceptedTransactionIds, ["tx-latest"]);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.rejectedCount, 0);
  assert.equal(statusCalls, 2);
  assert.equal((await getUserSubscription(db, "apple-user")).isSubscribed, true);
});

test("rejects tokenless or differently linked purchases", async (t) => {
  const db = await openDb(t);
  const expected = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  const runtime = makeRuntime("4a54ef16-bf76-4e1a-87fe-a55db3042c07");
  await assert.rejects(
    verifyAppleEvidenceForUser(db, {
      uid: "apple-user",
      appAccountToken: expected,
      runtime,
      body: {
        source: "restore",
        evidence: [{ signedTransactionInfo: "purchase-transaction" }],
      },
    }),
    (error) =>
      error instanceof AppleSubscriptionError &&
      error.code === "APPLE_PURCHASE_ACCOUNT_MISMATCH" &&
      error.details?.rejectedCount === 1
  );
});

test("accepts valid evidence when a sibling JWS is invalid", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES ('partial-user', 'partial', ?, 1, 1)`,
    [token]
  );
  const result = await verifyAppleEvidenceForUser(db, {
    uid: "partial-user",
    appAccountToken: token,
    runtime: makeRuntime(token),
    body: {
      source: "transaction_update",
      evidence: [
        { signedTransactionInfo: "purchase-transaction" },
        { signedTransactionInfo: "invalid-transaction" },
      ],
    },
  });

  assert.deepEqual(result.acceptedTransactionIds, ["tx-latest"]);
  assert.deepEqual(result.rejected, [
    { index: 1, code: "APPLE_VERIFICATION_FAILED", retryable: false },
  ]);
  assert.equal(result.rejectedCount, 1);
});

test("persists a valid chain when a sibling chain status lookup fails", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES ('chain-user', 'chain', ?, 1, 1)`,
    [token]
  );
  const runtime = makeRuntime(token);
  const apiClient = runtime.apiClients.get("Sandbox");
  const getStatuses = apiClient.getAllSubscriptionStatuses.bind(apiClient);
  apiClient.getAllSubscriptionStatuses = async (transactionId) => {
    if (transactionId === "tx-other") throw new Error("Apple unavailable");
    return getStatuses(transactionId);
  };

  const result = await verifyAppleEvidenceForUser(db, {
    uid: "chain-user",
    appAccountToken: token,
    runtime,
    body: {
      source: "restore",
      evidence: [
        { signedTransactionInfo: "purchase-transaction" },
        { signedTransactionInfo: "other-chain-transaction" },
      ],
    },
  });

  assert.deepEqual(result.acceptedTransactionIds, ["tx-latest"]);
  assert.deepEqual(result.rejected, [
    { index: 1, code: "APPLE_STATUS_UNAVAILABLE", retryable: true },
  ]);
  assert.equal((await getUserSubscription(db, "chain-user")).isSubscribed, true);
});

test("returns a non-200 error with safe rejection details when all evidence fails", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await assert.rejects(
    verifyAppleEvidenceForUser(db, {
      uid: "failed-user",
      appAccountToken: token,
      runtime: makeRuntime(token),
      body: {
        source: "purchase",
        evidence: [
          { signedTransactionInfo: "invalid-transaction" },
          { signedTransactionInfo: "" },
        ],
      },
    }),
    (error) => {
      assert.equal(error.code, "APPLE_VERIFICATION_FAILED");
      assert.equal(error.status, 422);
      assert.equal(error.details.rejectedCount, 2);
      assert.deepEqual(error.details.rejected[1], {
        index: 1,
        code: "INVALID_APPLE_EVIDENCE",
        retryable: false,
      });
      return true;
    }
  );
});

test("processes and deduplicates Notifications V2", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES (?, 'notify-user', ?, 1, 1)`,
    ["notify-user", token]
  );
  const runtime = makeRuntime(token);
  const first = await processAppleNotification(db, "signed-notification", {
    runtime,
  });
  const second = await processAppleNotification(db, "signed-notification", {
    runtime,
  });

  assert.equal(first.matchedUser, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
});

test("concurrent duplicate notifications perform entitlement work once", async (t) => {
  const db = await openDb(t);
  const token = "1b574614-4789-4a3a-b8d4-bd16b6814b30";
  await db.run(
    `INSERT INTO users (
       uid, username, apple_app_account_token, created_at, updated_at
     ) VALUES (?, 'notify-user', ?, 1, 1)`,
    ["notify-user", token]
  );
  const runtime = makeRuntime(token);
  const verifier = runtime.verifiers.get("Sandbox");
  const decodeTransaction = verifier.verifyAndDecodeTransaction.bind(verifier);
  let transactionDecodes = 0;
  verifier.verifyAndDecodeTransaction = async (...args) => {
    transactionDecodes += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return decodeTransaction(...args);
  };

  const results = await Promise.all([
    processAppleNotification(db, "signed-notification", { runtime }),
    processAppleNotification(db, "signed-notification", { runtime }),
  ]);

  assert.deepEqual(
    results.map(({ duplicate }) => duplicate).sort(),
    [false, true]
  );
  assert.equal(transactionDecodes, 1);
});
