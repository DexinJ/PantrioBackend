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

initFirebaseAdmin();

const app = express();

await initDb();
const appleConfiguration = initializeAppleSubscriptions();
console.log(
  appleConfiguration.enabled
    ? `Apple subscriptions enabled (${appleConfiguration.environments.join(", ")})`
    : "Apple subscriptions disabled (configuration incomplete)"
);
attachRoutes(app);

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/chat",
  maxPayload: MAX_WS_PAYLOAD_BYTES,
});

attachChatGateway(wss);

server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}/health`);
  console.log(`WS:   ws://localhost:${PORT}/chat`);
});
