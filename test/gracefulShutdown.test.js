import assert from "node:assert/strict";
import test from "node:test";

import { createGracefulShutdown } from "../src/operations/gracefulShutdown.js";

function quietLogger() {
  return { log() {}, error() {} };
}

test("graceful shutdown is idempotent and closes the database after draining", async () => {
  const events = [];
  let finishServerClose;
  let finishWebSocketClose;
  let finishWorker;
  const worker = new Promise((resolve) => {
    finishWorker = resolve;
  });
  const server = {
    close(callback) {
      events.push("server-close-requested");
      finishServerClose = callback;
    },
  };
  const wss = {
    clients: new Set(),
    close(callback) {
      events.push("ws-close-requested");
      finishWebSocketClose = callback;
    },
  };
  const exits = [];
  const shutdown = createGracefulShutdown({
    server,
    wss,
    stopBackgroundWork() {
      events.push("background-stopped");
    },
    waitForBackgroundWork() {
      events.push("worker-waited");
      return worker;
    },
    closeDatabase() {
      events.push("database-closed");
    },
    hardDeadlineMs: 1_000,
    logger: quietLogger(),
    exitProcess: (code) => exits.push(code),
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  assert.strictEqual(first, second);
  assert.deepEqual(events, [
    "background-stopped",
    "server-close-requested",
    "ws-close-requested",
  ]);

  finishServerClose();
  finishWebSocketClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("database-closed"), false);

  finishWorker();
  const result = await first;
  assert.deepEqual(result, { timedOut: false, failed: false });
  assert.equal(events.at(-1), "database-closed");
  assert.deepEqual(exits, [0]);
});

test("graceful shutdown terminates WebSocket clients after the grace period", async () => {
  let finishWebSocketClose;
  let closeRequests = 0;
  let terminations = 0;
  const client = {
    close(code) {
      closeRequests += 1;
      assert.equal(code, 1001);
    },
    terminate() {
      terminations += 1;
      wss.clients.delete(client);
      finishWebSocketClose();
    },
  };
  const wss = {
    clients: new Set([client]),
    close(callback) {
      finishWebSocketClose = callback;
    },
  };
  const exits = [];
  const shutdown = createGracefulShutdown({
    server: { close: (callback) => callback() },
    wss,
    closeDatabase() {},
    wsGraceMs: 5,
    wsTerminationSettleMs: 5,
    hardDeadlineMs: 1_000,
    logger: quietLogger(),
    exitProcess: (code) => exits.push(code),
  });

  const result = await shutdown("SIGTERM");
  assert.deepEqual(result, { timedOut: false, failed: false });
  assert.equal(closeRequests, 1);
  assert.equal(terminations, 1);
  assert.deepEqual(exits, [0]);
});

test("graceful shutdown still closes SQLite after a drain error", async () => {
  let databaseCloses = 0;
  const exits = [];
  const shutdown = createGracefulShutdown({
    server: {
      close(callback) {
        const error = new Error("HTTP drain failed");
        error.code = "HTTP_DRAIN_FAILED";
        callback(error);
      },
    },
    wss: { clients: new Set(), close: (callback) => callback() },
    closeDatabase() {
      databaseCloses += 1;
    },
    hardDeadlineMs: 1_000,
    logger: quietLogger(),
    exitProcess: (code) => exits.push(code),
  });

  const result = await shutdown("SIGTERM");
  assert.deepEqual(result, { timedOut: false, failed: true });
  assert.equal(databaseCloses, 1);
  assert.deepEqual(exits, [1]);
});

test("graceful shutdown forces a nonzero exit at the hard deadline", async () => {
  let forcedConnectionsClosed = 0;
  const exits = [];
  const shutdown = createGracefulShutdown({
    server: {
      close() {},
      closeAllConnections() {
        forcedConnectionsClosed += 1;
      },
    },
    wss: {
      clients: new Set(),
      close() {},
    },
    closeDatabase() {
      assert.fail("the database must not close while network work is still active");
    },
    wsGraceMs: 5,
    wsTerminationSettleMs: 5,
    hardDeadlineMs: 20,
    logger: quietLogger(),
    exitProcess: (code) => exits.push(code),
  });

  const result = await shutdown("SIGTERM");
  assert.deepEqual(result, { timedOut: true });
  assert.equal(forcedConnectionsClosed, 1);
  assert.deepEqual(exits, [1]);
});
