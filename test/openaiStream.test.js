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
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    body: null,
    text: async () => "provider unavailable",
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
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
});
