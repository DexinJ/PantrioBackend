import test from "node:test";
import assert from "node:assert/strict";

import {
  DAILY_TOKEN_LIMIT_REACHED_MESSAGE,
  REQUEST_EXCEEDS_TOKEN_BUDGET_MESSAGE,
  computeRemainingTokens,
  computeTokenBudget,
  estimateAudioTokensFromBytes,
  estimateTokensFromMessages,
} from "../src/usage/tokenBudget.js";

test("estimates string message content without mutating messages", () => {
  const messages = [{ role: "user", content: "What is in my fridge?" }];
  const original = structuredClone(messages);

  const estimate = estimateTokensFromMessages(messages);

  assert.ok(Number.isInteger(estimate));
  assert.ok(estimate > 0);
  assert.deepEqual(messages, original);
});

test("reserves one token per three serialized UTF-8 bytes", () => {
  const messages = [{ role: "user", content: "abc" }];
  const serializedBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");

  assert.equal(
    estimateTokensFromMessages(messages),
    Math.ceil(serializedBytes / 3) + 8 + 16
  );
});

test("includes nested structured content in the estimate", () => {
  const shortEstimate = estimateTokensFromMessages([
    { role: "user", content: [{ type: "text", text: "short" }] },
  ]);
  const structuredEstimate = estimateTokensFromMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(400) },
        {
          type: "image_url",
          image_url: { url: "https://example.test/fridge-photo.png" },
        },
      ],
      metadata: { source: "camera", retry: false },
    },
  ]);

  assert.ok(structuredEstimate > shortEstimate);
});

test("reserves vision tokens without counting an image data URL as text", () => {
  const imageDataUrl = `data:image/jpeg;base64,${"A".repeat(100_000)}`;
  const estimate = estimateTokensFromMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "What food is shown?" },
        {
          type: "image_url",
          image_url: { url: imageDataUrl },
        },
      ],
    },
  ]);

  assert.ok(estimate >= 4_096);
  assert.ok(estimate < 20_000);
});

test("applies the serialized UTF-8 byte ratio to multibyte text", () => {
  const ascii = estimateTokensFromMessages([
    { role: "user", content: "a".repeat(20) },
  ]);
  const emoji = estimateTokensFromMessages([
    { role: "user", content: "😀".repeat(20) },
  ]);

  assert.ok(emoji > ascii);
});

test("estimates audio capacity from uploaded bytes", () => {
  assert.equal(estimateAudioTokensFromBytes(64), 257);
  assert.equal(estimateAudioTokensFromBytes(65), 258);
  assert.equal(estimateAudioTokensFromBytes(240_000), 4_006);
  assert.throws(() => estimateAudioTokensFromBytes(0), /fileBytes/);
});

test("handles circular structured values without infinite recursion", () => {
  const content = { type: "text", text: "hello" };
  content.self = content;

  const estimate = estimateTokensFromMessages([{ role: "user", content }]);

  assert.ok(Number.isInteger(estimate));
  assert.ok(estimate > 0);
});

test("rejects non-array message input", () => {
  assert.throws(
    () => estimateTokensFromMessages({ role: "user", content: "hello" }),
    /messages must be an array/
  );
});

test("computes remaining tokens and clamps exhausted quotas to zero", () => {
  assert.equal(computeRemainingTokens(250, 1_000), 750);
  assert.equal(computeRemainingTokens(1_000, 1_000), 0);
  assert.equal(computeRemainingTokens(1_500, 1_000), 0);
});

test("rejects invalid quota configuration and usage values", () => {
  assert.throws(() => computeRemainingTokens(-1, 1_000), /tokensUsed/);
  assert.throws(() => computeRemainingTokens(0, 0), /dailyLimit/);
  assert.throws(
    () =>
      computeTokenBudget({
        tokensUsed: 0,
        dailyLimit: 1_000,
        maxCompletionTokens: 0,
        messages: [],
      }),
    /maxCompletionTokens/
  );
});

test("applies the configured per-request completion cap", () => {
  const budget = computeTokenBudget({
    tokensUsed: 100,
    dailyLimit: 1_000,
    maxCompletionTokens: 200,
    messages: [],
  });

  assert.deepEqual(budget, {
    ok: true,
    remainingTokens: 900,
    estPromptTokens: 0,
    maxCompletionTokens: 200,
  });
});

test("reduces completion allowance to fit the remaining daily quota", () => {
  const budget = computeTokenBudget({
    tokensUsed: 950,
    dailyLimit: 1_000,
    maxCompletionTokens: 200,
    messages: [],
  });

  assert.equal(budget.ok, true);
  assert.equal(budget.maxCompletionTokens, 50);
});

test("returns a neutral message when the daily quota is exhausted", () => {
  const budget = computeTokenBudget({
    tokensUsed: 1_000,
    dailyLimit: 1_000,
    maxCompletionTokens: 200,
    messages: [{ role: "user", content: "hello" }],
  });

  assert.deepEqual(budget, {
    ok: false,
    reason: DAILY_TOKEN_LIMIT_REACHED_MESSAGE,
    remainingTokens: 0,
  });
  assert.doesNotMatch(budget.reason, /sign[ -]?in|guest|trial/i);
});

test("rejects a prompt that consumes the remaining quota", () => {
  const messages = [{ role: "user", content: "x".repeat(120) }];
  const estimatedPromptTokens = estimateTokensFromMessages(messages);
  const budget = computeTokenBudget({
    tokensUsed: 0,
    dailyLimit: estimatedPromptTokens,
    maxCompletionTokens: 200,
    messages,
  });

  assert.deepEqual(budget, {
    ok: false,
    reason: REQUEST_EXCEEDS_TOKEN_BUDGET_MESSAGE,
    remainingTokens: estimatedPromptTokens,
    estPromptTokens: estimatedPromptTokens,
  });
  assert.doesNotMatch(budget.reason, /sign[ -]?in|guest|trial/i);
});

test("accepts a precomputed prompt estimate without serializing messages again", () => {
  assert.deepEqual(
    computeTokenBudget({
      tokensUsed: 100,
      dailyLimit: 1_000,
      maxCompletionTokens: 300,
      estPromptTokens: 200,
    }),
    {
      ok: true,
      remainingTokens: 900,
      estPromptTokens: 200,
      maxCompletionTokens: 300,
    }
  );
});
