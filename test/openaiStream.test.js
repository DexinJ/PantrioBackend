import assert from "node:assert/strict";
import test from "node:test";

test("sends the computed completion cap to Chat Completions", async (t) => {
  process.env.OPENAI_API_KEY ||= "test-openai-key";

  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const encoder = new TextEncoder();
    const event =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":4}}\n\n' +
      "data: [DONE]\n\n";

    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }),
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { streamOpenAIOnce } = await import(
    "../src/chat/openaiStream.js"
  );
  const ws = { OPEN: 1, readyState: 1 };
  const sent = [];

  const result = await streamOpenAIOnce({
    ws,
    send: (_socket, payload) => sent.push(payload),
    requestId: "quota-test",
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    controller: new AbortController(),
    maxTokens: 123,
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.max_completion_tokens, 123);
  assert.equal(requestBody.stream_options.include_usage, true);
  assert.ok(sent.some((payload) => payload.type === "usage"));
});

test("returns a structured upstream error so the gateway can reconcile quota first", async (t) => {
  process.env.OPENAI_API_KEY ||= "test-openai-key";
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logged = [];
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    body: null,
    text: async () => "provider unavailable",
  });
  console.error = (...args) => logged.push(args);
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const { streamOpenAIOnce } = await import(
    "../src/chat/openaiStream.js"
  );
  const sent = [];
  const result = await streamOpenAIOnce({
    ws: { OPEN: 1, readyState: 1 },
    send: (_socket, payload) => sent.push(payload),
    requestId: "upstream-error-test",
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hello" }],
    controller: new AbortController(),
    maxTokens: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UPSTREAM_ERROR");
  assert.equal(sent.length, 0);
  assert.equal(JSON.stringify(logged).includes("provider unavailable"), false);
});

test("aborts a stuck OpenAI request at the configured deadline", async (t) => {
  process.env.OPENAI_API_KEY ||= "test-openai-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { streamOpenAIOnce } = await import(
    "../src/chat/openaiStream.js"
  );
  const controller = new AbortController();

  await assert.rejects(
    streamOpenAIOnce({
      ws: { OPEN: 1, readyState: 1 },
      send: () => {},
      requestId: "timeout-test",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hello" }],
      controller,
      maxTokens: 100,
      timeoutMs: 10,
    }),
    (error) =>
      error?.name === "TimeoutError" && error?.code === "UPSTREAM_TIMEOUT"
  );
  assert.equal(controller.signal.aborted, true);
});

test("returns tool calls without publishing ownership and deduplicates progress", async (t) => {
  process.env.OPENAI_API_KEY ||= "test-openai-key";
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "server-call",
                type: "function",
                function: { name: "webSearch", arguments: '{"q"' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ':"milk"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];
  const event =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { streamOpenAIOnce } = await import("../src/chat/openaiStream.js");
  const sent = [];
  const result = await streamOpenAIOnce({
    ws: { OPEN: 1, readyState: 1 },
    send: (_socket, payload) => sent.push(payload),
    requestId: "tool-routing",
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "search" }],
    controller: new AbortController(),
    maxTokens: 100,
  });

  assert.equal(result.needsTools, true);
  assert.deepEqual(result.toolCalls, [
    {
      id: "server-call",
      type: "function",
      function: { name: "webSearch", arguments: '{"q":"milk"}' },
    },
  ]);
  assert.equal(sent.filter(({ type }) => type === "tool_progress").length, 1);
  assert.equal(sent.some(({ type }) => type === "tool_calls"), false);
});
