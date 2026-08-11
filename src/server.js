// src/server.js
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

import { PORT } from "./config/env.js";
import { initFirebaseAdmin } from "./auth/firebase.js";
import { attachRoutes } from "./http/routes.js";
import { attachChatGateway } from "./ws/chatGateway.js";
import { initDb } from "./db/initDb.js";
import { MAX_WS_PAYLOAD_BYTES } from "./config/policy.js";
import { initializeAppleSubscriptions } from "./subscriptions/appleConfig.js";
import { initializeAppleSignIn } from "./auth/appleSignInConfig.js";
import { closeDb, getDb } from "./db/db.js";
import { resumePendingAccountDeletions } from "./accountDeletion/accountDeletionService.js";
import { createGracefulShutdown } from "./operations/gracefulShutdown.js";
import { beginDraining } from "./operations/readiness.js";

initFirebaseAdmin();

const app = express();

await initDb();
const appleConfiguration = initializeAppleSubscriptions();
console.log(
  appleConfiguration.enabled
    ? `Apple subscriptions enabled (${appleConfiguration.environments.join(", ")})`
    : "Apple subscriptions disabled (configuration incomplete)"
);
const appleSignInConfiguration = initializeAppleSignIn();
console.log(
  appleSignInConfiguration.enabled
    ? `Sign in with Apple revocation enabled (${appleSignInConfiguration.clientId})`
    : appleSignInConfiguration.invalid
      ? "Sign in with Apple revocation disabled (configuration invalid)"
      : "Sign in with Apple revocation disabled (configuration incomplete)"
);

let accountDeletionRecoveryInFlight = null;
let shutdownRequested = false;
const runAccountDeletionRecovery = () => {
  if (shutdownRequested) {
    return accountDeletionRecoveryInFlight || Promise.resolve();
  }
  if (accountDeletionRecoveryInFlight) {
    return accountDeletionRecoveryInFlight;
  }

  accountDeletionRecoveryInFlight = (async () => {
    try {
      const db = await getDb();
      await resumePendingAccountDeletions(db, { batchSize: 25 });
    } catch (error) {
      console.error("[account deletion recovery worker]", {
        name: String(error?.name || "Error"),
        code: error?.code ? String(error.code) : null,
      });
    }
  })().finally(() => {
    accountDeletionRecoveryInFlight = null;
  });

  return accountDeletionRecoveryInFlight;
};

attachRoutes(app);

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/chat",
  maxPayload: MAX_WS_PAYLOAD_BYTES,
});

const chatGateway = attachChatGateway(wss);

const accountDeletionRecoveryInterval = setInterval(
  () => void runAccountDeletionRecovery(),
  60_000
);
accountDeletionRecoveryInterval.unref?.();
server.on("close", () => clearInterval(accountDeletionRecoveryInterval));

const shutdown = createGracefulShutdown({
  server,
  wss,
  stopBackgroundWork: () => {
    shutdownRequested = true;
    beginDraining();
    chatGateway.beginDrain();
    clearInterval(accountDeletionRecoveryInterval);
  },
  waitForBackgroundWork: async () => {
    const results = await Promise.allSettled([
      accountDeletionRecoveryInFlight || Promise.resolve(),
      chatGateway.waitForIdle(),
    ]);
    const failures = results
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length) {
      throw new AggregateError(failures, "Background work failed while draining");
    }
  },
  closeDatabase: () => closeDb({ checkpoint: true, terminal: true }),
});
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}/health`);
  console.log(`WS:   ws://localhost:${PORT}/chat`);
  if (!shutdownRequested) void runAccountDeletionRecovery();
});
