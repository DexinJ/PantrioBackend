import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { createAccountDeletion } from "../src/accountDeletion/accountDeletionStore.js";
import { getUsageRow } from "../src/usage/usageStore.js";
import { attachChatGateway } from "../src/ws/chatGateway.js";

class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  ping() {}

  terminate() {}
}

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

function connect(t, dependencies) {
  const wss = new FakeWebSocketServer();
  const ws = new FakeWebSocket();
  wss.clients.add(ws);
  const gatewayControl = attachChatGateway(wss, dependencies);
  ws.gatewayControl = gatewayControl;
  wss.emit("connection", ws);
  t.after(async () => {
    ws.emit("close");
    wss.emit("close");
    await gatewayControl.waitForIdle();
  });
  return ws;
}

async function flushMessages() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for a WebSocket response");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("rejects null, arrays, and primitive WebSocket payloads without escaping", async (t) => {
  const ws = connect(t, {
    verifySignedTokenFn: async () => {
      throw new Error("authentication must not run");
    },
  });

  ws.emit("message", Buffer.from("null"));
  ws.emit("message", Buffer.from("[]"));
  ws.emit("message", Buffer.from("7"));
  ws.emit("message", Buffer.from('"text"'));
  await flushMessages();

  assert.deepEqual(
    ws.sent.slice(1).map(({ code }) => code),
    [
      "INVALID_REQUEST",
      "INVALID_REQUEST",
      "INVALID_REQUEST",
      "INVALID_REQUEST",
    ]
  );
});

test("contains unexpected asynchronous WebSocket handler failures", async (t) => {
  const ws = connect(t);
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });

  ws.emit("message", {
    toString() {
      throw new Error("unexpected conversion failure");
    },
  });
  await flushMessages();

  assert.equal(ws.sent.at(-1).code, "INTERNAL_ERROR");
  assert.equal(
    ws.sent.at(-1).message,
    "The WebSocket request could not be processed."
  );
});

test("checks a local deletion tombstone before active Firebase verification", async (t) => {
  const db = await openDb(t);
  await createAccountDeletion(db, {
    uid: "firebase-user",
    appleIdentityLinked: false,
    nowMs: 1_700_000_000_000,
  });
  let activeVerifications = 0;
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "firebase-user" }),
    verifyActiveTokenFn: async () => {
      activeVerifications += 1;
      throw new Error("deleted Firebase user");
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "deletion-race",
        token: "cached-token",
        messages: [{ role: "user", content: "hello" }],
      })
    )
  );
  await waitFor(
    () => ws.sent.at(-1)?.code === "ACCOUNT_DELETION_IN_PROGRESS"
  );

  assert.equal(activeVerifications, 0);
  assert.equal(ws.sent.at(-1).code, "ACCOUNT_DELETION_IN_PROGRESS");
  assert.equal(ws.sent.at(-1).deletionStatus, "processing");
});

test("requires active Firebase verification when no tombstone exists", async (t) => {
  const db = await openDb(t);
  const calls = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => {
      calls.push("signed");
      return { uid: "firebase-user" };
    },
    verifyActiveTokenFn: async () => {
      calls.push("active");
      throw new Error("revoked token");
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "revoked-token",
        token: "cached-token",
        messages: [{ role: "user", content: "hello" }],
      })
    )
  );
  await waitFor(() => ws.sent.at(-1)?.code === "AUTH_INVALID");

  assert.deepEqual(calls, ["signed", "active"]);
  assert.equal(ws.sent.at(-1).code, "AUTH_INVALID");
});

test("maps a late deletion trigger race to the stable WebSocket 410 contract", async (t) => {
  const db = await openDb(t);
  let streamCalls = 0;
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "late-delete-user" }),
    verifyActiveTokenFn: async () => {
      await createAccountDeletion(db, {
        uid: "late-delete-user",
        appleIdentityLinked: false,
        nowMs: 1_700_000_000_000,
      });
      return { uid: "late-delete-user" };
    },
    streamOpenAIOnceFn: async () => {
      streamCalls += 1;
      throw new Error("stream should not start");
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "late-delete-race",
        token: "valid-token",
        messages: [{ role: "user", content: "hello" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(({ code }) => code === "ACCOUNT_DELETION_IN_PROGRESS")
  );

  const response = ws.sent.find(
    ({ code }) => code === "ACCOUNT_DELETION_IN_PROGRESS"
  );
  assert.equal(response.deletionStatus, "processing");
  assert.equal(JSON.stringify(response).includes("ACCOUNT_DELETION_BLOCKED"), false);
  assert.equal(streamCalls, 0);
});

test("rejects duplicate request IDs while a start is pending and aborts it on close", async (t) => {
  const db = await openDb(t);
  let releaseSignedVerification;
  const signedVerification = new Promise((resolve) => {
    releaseSignedVerification = resolve;
  });
  let signedVerificationCalls = 0;
  let streamCalls = 0;
  let streamAborted = false;

  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => {
      signedVerificationCalls += 1;
      return signedVerification;
    },
    verifyActiveTokenFn: async () => ({ uid: "duplicate-user" }),
    streamOpenAIOnceFn: async ({ controller }) => {
      streamCalls += 1;
      return new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            streamAborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    },
  });
  const startMessage = Buffer.from(
    JSON.stringify({
      type: "start",
      requestId: "same-request",
      token: "valid-token",
      messages: [{ role: "user", content: "hello" }],
    })
  );

  ws.emit("message", startMessage);
  ws.emit("message", startMessage);

  await waitFor(() =>
    ws.sent.some(({ code }) => code === "DUPLICATE_REQUEST_ID")
  );
  assert.equal(signedVerificationCalls, 1);
  assert.equal(streamCalls, 0);

  releaseSignedVerification({ uid: "duplicate-user" });
  await waitFor(() => ws.sent.some(({ type }) => type === "started"));
  await waitFor(() => streamCalls === 1);

  ws.emit("close");
  await waitFor(() => streamAborted);
  assert.equal(streamCalls, 1);
});

test("bounds pending starts before authentication work begins", async (t) => {
  let releaseVerification;
  const verificationGate = new Promise((resolve) => {
    releaseVerification = resolve;
  });
  let verificationCalls = 0;
  const ws = connect(t, {
    verifySignedTokenFn: async () => {
      verificationCalls += 1;
      await verificationGate;
      throw new Error("invalid token");
    },
  });

  for (let index = 1; index <= 5; index += 1) {
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "start",
          requestId: `pending-${index}`,
          token: "unverified-token",
          messages: [{ role: "user", content: "hello" }],
        })
      )
    );
  }

  await waitFor(() => ws.sent.some(({ code }) => code === "CHAT_BUSY"));
  assert.equal(verificationCalls, 4);

  releaseVerification();
  await ws.gatewayControl.waitForIdle();
  assert.equal(
    ws.sent.filter(({ code }) => code === "AUTH_INVALID").length,
    4
  );

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "pending-after-release",
        token: "unverified-token",
        messages: [{ role: "user", content: "hello" }],
      })
    )
  );
  await waitFor(() => verificationCalls === 5);
  await ws.gatewayControl.waitForIdle();
});

test("gateway drain waits for an aborted stream to reconcile its quota reservation", async (t) => {
  const db = await openDb(t);
  let streamStarted = false;
  let finishAbortedStream;
  let observeAbort;
  const abortObserved = new Promise((resolve) => {
    observeAbort = resolve;
  });
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "drain-user" }),
    verifyActiveTokenFn: async () => ({ uid: "drain-user" }),
    streamOpenAIOnceFn: async ({ controller }) => {
      streamStarted = true;
      return new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            finishAbortedStream = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            observeAbort();
          },
          { once: true }
        );
      });
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "draining-stream",
        token: "valid-token",
        messages: [{ role: "user", content: "hello" }],
      })
    )
  );
  await waitFor(() => streamStarted);

  const reserved = await getUsageRow(db, "user", "drain-user");
  assert.ok(reserved.tokens_used > 0);
  assert.equal(reserved.requests, 0);

  ws.gatewayControl.beginDrain();
  ws.emit("close");
  await abortObserved;

  let drainSettled = false;
  const drain = ws.gatewayControl.waitForIdle().then(() => {
    drainSettled = true;
  });
  await flushMessages();
  assert.equal(drainSettled, false);

  finishAbortedStream();
  await drain;

  const reconciled = await getUsageRow(db, "user", "drain-user");
  assert.equal(reconciled.tokens_used, reserved.tokens_used);
  assert.equal(reconciled.requests, 1);
});

test("partial tool results retain their timeout and release chat capacity", async (t) => {
  const db = await openDb(t);
  const completedRequestIds = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "partial-tools-user" }),
    verifyActiveTokenFn: async () => ({ uid: "partial-tools-user" }),
    toolResultsTimeoutMs: 15,
    streamOpenAIOnceFn: async ({ requestId }) => {
      if (requestId === "partial-tools") {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            { id: "client-call-1", function: { name: "addFridgeItem" } },
            { id: "client-call-2", function: { name: "addShoppingItem" } },
          ],
          usage: { total_tokens: 10 },
        };
      }
      completedRequestIds.push(requestId);
      return {
        ok: true,
        needsTools: false,
        toolCalls: [],
        usage: { total_tokens: 10 },
      };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "partial-tools",
        token: "valid-token",
        messages: [{ role: "user", content: "use two tools" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "partial-tools"
    )
  );

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "partial-tools",
        results: [{ tool_call_id: "client-call-1", content: "{}" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ code, requestId }) =>
        code === "TOOL_RESULTS_TIMEOUT" && requestId === "partial-tools"
    )
  );

  for (const requestId of ["after-partial-1", "after-partial-2"]) {
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "start",
          requestId,
          token: "valid-token",
          messages: [{ role: "user", content: "continue" }],
        })
      )
    );
  }
  await waitFor(() => completedRequestIds.length === 2);
  await waitFor(
    () =>
      ws.sent.filter(
        ({ type, requestId }) =>
          type === "done" && requestId.startsWith("after-partial-")
      ).length === 2
  );
  assert.equal(
    ws.sent.some(
      ({ code, requestId }) =>
        code === "CHAT_BUSY" && requestId.startsWith("after-partial-")
    ),
    false
  );
});

test("early partial tool results receive a timeout once tool calls are known", async (t) => {
  const db = await openDb(t);
  let finishFirstRound;
  let firstRoundStarted = false;
  const firstRound = new Promise((resolve) => {
    finishFirstRound = resolve;
  });
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "early-tools-user" }),
    verifyActiveTokenFn: async () => ({ uid: "early-tools-user" }),
    toolResultsTimeoutMs: 15,
    streamOpenAIOnceFn: async () => {
      firstRoundStarted = true;
      return firstRound;
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "early-partial-tools",
        token: "valid-token",
        messages: [{ role: "user", content: "use two tools" }],
      })
    )
  );
  await waitFor(() => firstRoundStarted);

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "early-partial-tools",
        results: [{ tool_call_id: "early-call-1", content: "{}" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "queued_tool_results" && requestId === "early-partial-tools"
    )
  );

  finishFirstRound({
    ok: true,
    needsTools: true,
    toolCalls: [
      { id: "early-call-1", function: { name: "addFridgeItem" } },
      { id: "early-call-2", function: { name: "addShoppingItem" } },
    ],
    usage: { total_tokens: 10 },
  });

  await waitFor(() =>
    ws.sent.some(
      ({ code, requestId }) =>
        code === "TOOL_RESULTS_TIMEOUT" &&
        requestId === "early-partial-tools"
    )
  );
});

test("routes a mixed tool batch so the client receives only client-owned calls once", async (t) => {
  const db = await openDb(t);
  let streamRound = 0;
  let continuationMessages = null;
  const serverCallsSeen = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "mixed-tools-user" }),
    verifyActiveTokenFn: async () => ({ uid: "mixed-tools-user" }),
    runToolCallsFn: async (calls) => {
      serverCallsSeen.push(...calls.map((call) => call.id));
      return [
        {
          role: "tool",
          tool_call_id: "server-search",
          content: JSON.stringify({ results: ["milk"] }),
        },
      ];
    },
    streamOpenAIOnceFn: async ({ messages }) => {
      streamRound += 1;
      if (streamRound === 1) {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            {
              id: "server-search",
              type: "function",
              function: { name: "webSearch", arguments: '{"query":"milk"}' },
            },
            {
              id: "client-add",
              type: "function",
              function: {
                name: "addFridgeItem",
                arguments: '{"name":"milk"}',
              },
            },
          ],
          usage: { total_tokens: 10 },
        };
      }
      continuationMessages = messages;
      return {
        ok: true,
        needsTools: false,
        toolCalls: [],
        usage: { total_tokens: 10 },
      };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "mixed-tools",
        token: "valid-token",
        messages: [{ role: "user", content: "search and add milk" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "mixed-tools"
    )
  );

  const ownershipFrames = ws.sent.filter(
    ({ type, requestId }) =>
      (type === "tool_calls" || type === "awaiting_tool_results") &&
      requestId === "mixed-tools"
  );
  assert.equal(ownershipFrames.length, 1);
  assert.equal(ownershipFrames[0].toolOwner, "client");
  assert.deepEqual(
    ownershipFrames[0].toolCalls.map(({ id }) => id),
    ["client-add"]
  );
  assert.deepEqual(serverCallsSeen, ["server-search"]);

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "mixed-tools",
        results: [
          {
            tool_call_id: "client-add",
            content: JSON.stringify({ success: true }),
          },
        ],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "done" && requestId === "mixed-tools"
    )
  );

  const assistantToolCallMessage = continuationMessages.find(
    ({ role, tool_calls: toolCalls }) => role === "assistant" && toolCalls
  );
  assert.deepEqual(
    assistantToolCallMessage.tool_calls.map(({ id }) => id),
    ["server-search", "client-add"]
  );
  assert.deepEqual(
    continuationMessages
      .filter(({ role }) => role === "tool")
      .map(({ tool_call_id: id }) => id)
      .sort(),
    ["client-add", "server-search"]
  );
});

test("recipe intent forces one recommendation, then allows exactly one shopping-list follow-up", async (t) => {
  const db = await openDb(t);
  const rounds = [];
  const serverCallsSeen = [];
  let serverContext = null;
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "recipe-tools-user" }),
    verifyActiveTokenFn: async () => ({ uid: "recipe-tools-user" }),
    runToolCallsFn: async (calls, context) => {
      serverCallsSeen.push(...calls.map((call) => call.function.name));
      serverContext = context.recipeContext;
      return calls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ recipes: [{ title: "Test recipe" }] }),
      }));
    },
    streamOpenAIOnceFn: async (options) => {
      rounds.push(options);
      if (rounds.length === 1) {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            {
              id: "recipe-call",
              type: "function",
              function: { name: "recommendRecipes", arguments: "{}" },
            },
            {
              id: "unsafe-extra-call",
              type: "function",
              function: {
                name: "proposeAddAllToFridge",
                arguments: '{"items":[{"name":"recipe ingredient"}]}',
              },
            },
          ],
          usage: { total_tokens: 10 },
        };
      }
      return {
        ok: true,
        needsTools: false,
        toolCalls: [],
        usage: { total_tokens: 10 },
      };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "isolated-recipes",
        token: "valid-token",
        intent: "recipe_recommendation",
        recipeContext: {
          inventory: [{ name: " spinach ", quantity: "1 bag" }],
          preferences: { explicit: { preferredCuisines: ["Thai"] } },
          ignored: "not trusted",
        },
        messages: [{ role: "user", content: "Suggest a light Thai meal" }],
      })
    )
  );

  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "done" && requestId === "isolated-recipes"
    )
  );

  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds[0].tools.map(({ function: tool }) => tool.name),
    ["recommendRecipes"]
  );
  assert.deepEqual(rounds[0].toolChoice, {
    type: "function",
    function: { name: "recommendRecipes" },
  });
  assert.equal(rounds[0].parallelToolCalls, false);
  assert.deepEqual(
    rounds[1].tools.map(({ function: tool }) => tool.name),
    ["proposeAddMissingIngredientsToShoppingList"]
  );
  assert.equal(rounds[1].toolChoice, "auto");
  assert.equal(rounds[1].parallelToolCalls, false);
  assert.deepEqual(serverCallsSeen, ["recommendRecipes"]);
  assert.deepEqual(serverContext.inventory, [
    { name: "spinach", quantity: "1 bag" },
  ]);
  assert.equal("ignored" in serverContext, false);
  assert.equal(
    ws.sent.some(({ type }) => type === "tool_calls"),
    false
  );
  const recipeToolMessage = rounds[1].messages.find(
    (message) =>
      message?.role === "tool" && message?.tool_call_id === "recipe-call"
  );
  const compacted = JSON.parse(recipeToolMessage.content);
  assert.equal(compacted.recipes[0].title, "Test recipe");
  assert.equal("instructions" in compacted.recipes[0], false);
  assert.equal("ingredients" in compacted.recipes[0], false);
  assert.deepEqual(
    rounds[1].messages
      .filter(({ role }) => role === "tool")
      .map(({ tool_call_id: id }) => id)
      .sort(),
    ["recipe-call", "unsafe-extra-call"]
  );
});

test("recipe follow-up is allowed once, then tools are locked", async (t) => {
  const db = await openDb(t);
  const rounds = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "recipe-followup-user" }),
    verifyActiveTokenFn: async () => ({ uid: "recipe-followup-user" }),
    streamOpenAIOnceFn: async (options) => {
      rounds.push(options);
      if (rounds.length === 1) {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            {
              id: "recipe-call",
              type: "function",
              function: { name: "recommendRecipes", arguments: "{}" },
            },
          ],
          usage: { total_tokens: 10 },
        };
      }
      if (rounds.length === 2) {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            {
              id: "follow-up-call",
              type: "function",
              function: {
                name: "proposeAddMissingIngredientsToShoppingList",
                arguments: '{"items":[{"name":"soy sauce"}]}',
              },
            },
          ],
          usage: { total_tokens: 10 },
        };
      }
      return {
        ok: true,
        needsTools: false,
        toolCalls: [],
        usage: { total_tokens: 10 },
      };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "recipe-followup",
        token: "valid-token",
        intent: "recipe_recommendation",
        messages: [{ role: "user", content: "Suggest dinner" }],
      })
    )
  );

  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "recipe-followup"
    )
  );

  const followUpFrame = ws.sent.find(
    ({ type, requestId }) =>
      type === "tool_calls" && requestId === "recipe-followup"
  );
  assert.deepEqual(
    followUpFrame.toolCalls.map(({ id }) => id),
    ["follow-up-call"]
  );

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "recipe-followup",
        results: [
          {
            tool_call_id: "follow-up-call",
            content: JSON.stringify({ ok: true, proposalShown: true }),
          },
        ],
      })
    )
  );

  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "done" && requestId === "recipe-followup"
    )
  );

  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds[2].tools, []);
  assert.equal(rounds[2].toolChoice, undefined);
});

test("preference proposals isolate one confirmation from mutation tools", async (t) => {
  const db = await openDb(t);
  const rounds = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "preference-tools-user" }),
    verifyActiveTokenFn: async () => ({ uid: "preference-tools-user" }),
    streamOpenAIOnceFn: async (options) => {
      rounds.push(options);
      if (rounds.length === 1) {
        return {
          ok: true,
          needsTools: true,
          toolCalls: [
            {
              id: "preference-proposal",
              type: "function",
              function: {
                name: "proposeRecipePreferenceUpdate",
                arguments:
                  '{"operation":"merge","patch":{"preferredCuisines":["Thai"]}}',
              },
            },
            {
              id: "unsafe-fridge-add",
              type: "function",
              function: { name: "addFridgeItem", arguments: '{"name":"Thai"}' },
            },
          ],
          usage: { total_tokens: 10 },
        };
      }
      return {
        ok: true,
        needsTools: false,
        toolCalls: [],
        usage: { total_tokens: 10 },
      };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "isolated-preferences",
        token: "valid-token",
        messages: [
          { role: "user", content: "Remember that I prefer Thai recipes" },
        ],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "isolated-preferences"
    )
  );

  const proposalFrame = ws.sent.find(
    ({ type, requestId }) =>
      type === "tool_calls" && requestId === "isolated-preferences"
  );
  assert.deepEqual(
    proposalFrame.toolCalls.map(({ id }) => id),
    ["preference-proposal"]
  );

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "isolated-preferences",
        results: [
          {
            tool_call_id: "preference-proposal",
            content: JSON.stringify({ ok: true, proposalShown: true }),
          },
        ],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "done" && requestId === "isolated-preferences"
    )
  );

  assert.deepEqual(rounds[1].tools, []);
  assert.deepEqual(
    rounds[1].messages
      .filter(({ role }) => role === "tool")
      .map(({ tool_call_id: id }) => id)
      .sort(),
    ["preference-proposal", "unsafe-fridge-add"]
  );
});

test("bulk fridge proposals cannot repeat across tool rounds", async (t) => {
  const db = await openDb(t);
  const rounds = [];
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "bulk-proposal-user" }),
    verifyActiveTokenFn: async () => ({ uid: "bulk-proposal-user" }),
    streamOpenAIOnceFn: async (options) => {
      rounds.push(options);
      return rounds.length === 1
        ? {
            ok: true,
            needsTools: true,
            toolCalls: [
              {
                id: "bulk-proposal",
                type: "function",
                function: {
                  name: "proposeAddAllToFridge",
                  arguments: '{"items":[{"name":"milk"}]}',
                },
              },
            ],
            usage: { total_tokens: 10 },
          }
        : {
            ok: true,
            needsTools: false,
            toolCalls: [],
            usage: { total_tokens: 10 },
          };
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "one-bulk-proposal",
        token: "valid-token",
        messages: [{ role: "user", content: "Add the items from my image" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "one-bulk-proposal"
    )
  );
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "one-bulk-proposal",
        results: [
          {
            tool_call_id: "bulk-proposal",
            content: JSON.stringify({ ok: true, proposalShown: true }),
          },
        ],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "done" && requestId === "one-bulk-proposal"
    )
  );

  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[1].tools, []);
});

test("a client cannot satisfy a server-owned tool ID while that tool is running", async (t) => {
  const db = await openDb(t);
  let releaseServerTool;
  let markServerToolStarted;
  const serverToolStarted = new Promise((resolve) => {
    markServerToolStarted = resolve;
  });
  const serverToolGate = new Promise((resolve) => {
    releaseServerTool = resolve;
  });
  let streamRounds = 0;
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "forged-result-user" }),
    verifyActiveTokenFn: async () => ({ uid: "forged-result-user" }),
    streamOpenAIOnceFn: async () => {
      streamRounds += 1;
      return {
        ok: true,
        needsTools: true,
        toolCalls: [
          {
            id: "owned-by-server",
            type: "function",
            function: { name: "webSearch", arguments: "{}" },
          },
          {
            id: "owned-by-client",
            type: "function",
            function: { name: "addFridgeItem", arguments: "{}" },
          },
        ],
        usage: { total_tokens: 10 },
      };
    },
    runToolCallsFn: async () => {
      markServerToolStarted();
      await serverToolGate;
      return [
        {
          role: "tool",
          tool_call_id: "owned-by-server",
          content: "{}",
        },
      ];
    },
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "forged-server-result",
        token: "valid-token",
        messages: [{ role: "user", content: "use tools" }],
      })
    )
  );
  await serverToolStarted;
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "tool_results",
        requestId: "forged-server-result",
        results: [{ tool_call_id: "owned-by-server", content: "{}" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ type, requestId }) =>
        type === "queued_tool_results" && requestId === "forged-server-result"
    )
  );
  releaseServerTool();
  await waitFor(() =>
    ws.sent.some(
      ({ code, requestId }) =>
        code === "INVALID_TOOL_RESULT" &&
        requestId === "forged-server-result"
    )
  );

  assert.equal(streamRounds, 1);
  assert.equal(
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "forged-server-result"
    ),
    false
  );
});

test("server-tool timeout aborts and settles work without ghost frames", async (t) => {
  const db = await openDb(t);
  let toolSignalAborted = false;
  let toolWorkSettled = false;
  const ws = connect(t, {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "tool-timeout-user" }),
    verifyActiveTokenFn: async () => ({ uid: "tool-timeout-user" }),
    serverToolTimeoutMs: 10,
    streamOpenAIOnceFn: async () => ({
      ok: true,
      needsTools: true,
      toolCalls: [
        {
          id: "slow-server-tool",
          type: "function",
          function: { name: "webSearch", arguments: "{}" },
        },
      ],
      usage: { total_tokens: 10 },
    }),
    runToolCallsFn: async (_calls, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            toolSignalAborted = true;
            setImmediate(() => {
              ctx.wsSend({
                type: "tool",
                requestId: ctx.requestId,
                name: "webSearch",
                result: { late: true },
              });
              toolWorkSettled = true;
              resolve([
                {
                  role: "tool",
                  tool_call_id: "slow-server-tool",
                  content: "{}",
                },
              ]);
            });
          },
          { once: true }
        );
      }),
  });

  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "tool-timeout",
        token: "valid-token",
        messages: [{ role: "user", content: "search" }],
      })
    )
  );
  await waitFor(() =>
    ws.sent.some(
      ({ code, requestId }) =>
        code === "SERVER_TOOL_TIMEOUT" && requestId === "tool-timeout"
    )
  );
  await ws.gatewayControl.waitForIdle();

  assert.equal(toolSignalAborted, true);
  assert.equal(toolWorkSettled, true);
  assert.equal(
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool" && requestId === "tool-timeout"
    ),
    false
  );
  assert.equal(
    ws.sent.some(
      ({ type, requestId }) =>
        type === "tool_calls" && requestId === "tool-timeout"
    ),
    false
  );
});

test("bounds concurrent chat streams per user and releases slots on close", async (t) => {
  const db = await openDb(t);
  const controllers = [];
  const dependencies = {
    getDbFn: async () => db,
    verifySignedTokenFn: async () => ({ uid: "concurrency-user" }),
    verifyActiveTokenFn: async () => ({ uid: "concurrency-user" }),
    streamOpenAIOnceFn: async ({ controller }) => {
      controllers.push(controller);
      return new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    },
  };
  const ws = connect(t, dependencies);

  for (const requestId of ["concurrent-1", "concurrent-2", "concurrent-3"]) {
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "start",
          requestId,
          token: "valid-token",
          messages: [{ role: "user", content: "hello" }],
        })
      )
    );
  }

  await waitFor(() => ws.sent.some(({ code }) => code === "CHAT_BUSY"));
  await waitFor(
    () => ws.sent.filter(({ type }) => type === "started").length === 2
  );
  assert.equal(controllers.length, 2);

  ws.emit("close");
  await waitFor(() => controllers.every(({ signal }) => signal.aborted));

  let completedStreams = 0;
  const nextWs = connect(t, {
    ...dependencies,
    streamOpenAIOnceFn: async () => {
      completedStreams += 1;
      return {
        ok: true,
        finishReason: "stop",
        needsTools: false,
        toolCalls: [],
        usage: null,
      };
    },
  });
  nextWs.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start",
        requestId: "after-close",
        token: "valid-token",
        messages: [{ role: "user", content: "hello again" }],
      })
    )
  );
  await waitFor(() =>
    nextWs.sent.some(
      ({ type, requestId }) => type === "done" && requestId === "after-close"
    )
  );
  assert.equal(completedStreams, 1);
});
