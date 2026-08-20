import assert from "node:assert/strict";
import test from "node:test";

import {
  findToolRoundSegments,
  trimWorkingMessagesToFit,
} from "../src/chat/messageTrimmer.js";
import { estimateTokensFromMessages } from "../src/usage/tokenBudget.js";

const system = { role: "system", content: "Reply in en." };

function user(text) {
  return { role: "user", content: text };
}

function assistant(text) {
  return { role: "assistant", content: text };
}

function toolRound(id, payload) {
  return [
    {
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name: "fridgeTool", arguments: "{}" } }],
      content: null,
    },
    { role: "tool", tool_call_id: id, content: payload },
  ];
}

test("findToolRoundSegments returns complete rounds oldest-first", () => {
  const messages = [
    system,
    user("hello"),
    ...toolRound("call-1", "big payload one"),
    assistant("done"),
    ...toolRound("call-2", "big payload two"),
  ];

  assert.deepEqual(findToolRoundSegments(messages), [
    { start: 2, end: 3 },
    { start: 5, end: 6 },
  ]);
});

test("findToolRoundSegments ignores incomplete rounds", () => {
  const messages = [
    system,
    user("hello"),
    {
      role: "assistant",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "b", arguments: "{}" } },
      ],
      content: null,
    },
    { role: "tool", tool_call_id: "call-1", content: "only one answer" },
  ];

  assert.deepEqual(findToolRoundSegments(messages), []);
});

test("trimWorkingMessagesToFit returns the same list when it already fits", () => {
  const messages = [system, user("hello")];
  const result = trimWorkingMessagesToFit(messages, 10_000);
  assert.equal(result, messages);
});

test("trimWorkingMessagesToFit drops the oldest tool round until it fits", () => {
  const base = [system, user("hello"), assistant("early reply")];
  const newestRound = toolRound("call-2", "newest tool payload");
  const oldestRound = toolRound("call-1", "x".repeat(5_000));
  const messages = [...base, ...oldestRound, ...newestRound];

  const cap = estimateTokensFromMessages([...base, ...newestRound]);

  const trimmed = trimWorkingMessagesToFit(messages, cap);
  assert.ok(trimmed);
  assert.deepEqual(trimmed, [...base, ...newestRound]);
});

test("trimWorkingMessagesToFit removes multiple rounds oldest-first", () => {
  const base = [system, user("hello")];
  const largeRound = (id) => toolRound(id, "y".repeat(4_000));
  const messages = [...base, ...largeRound("call-1"), ...largeRound("call-2")];

  const cap = estimateTokensFromMessages(base);

  const trimmed = trimWorkingMessagesToFit(messages, cap);
  assert.ok(trimmed);
  assert.deepEqual(trimmed, base);
});

test("trimWorkingMessagesToFit returns null when the base conversation is too large", () => {
  const base = [system, user("z".repeat(10_000))];
  const messages = [...base, ...toolRound("call-1", "payload")];

  const cap = estimateTokensFromMessages(base) - 1;

  assert.equal(trimWorkingMessagesToFit(messages, cap), null);
});

test("trimWorkingMessagesToFit returns null for incomplete rounds", () => {
  const messages = [
    system,
    user("hello"),
    {
      role: "assistant",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "b", arguments: "{}" } },
      ],
      content: null,
    },
    { role: "tool", tool_call_id: "call-1", content: "x".repeat(10_000) },
  ];

  assert.equal(trimWorkingMessagesToFit(messages, 100), null);
});

test("trimWorkingMessagesToFit counts extraMessages but never trims them", () => {
  const base = [system, user("hello")];
  const round = toolRound("call-1", "p".repeat(4_000));
  const messages = [...base, ...round];
  const extraMessages = [
    { role: "system", content: { tools: [{ type: "function", function: { name: "t" } }] } },
  ];

  // The cap only fits once the tool definitions are included in the estimate.
  const cap = estimateTokensFromMessages([...base, ...extraMessages]);

  // Base conversation + tool definitions fit exactly; the trimmer keeps it.
  assert.deepEqual(trimWorkingMessagesToFit(base, cap, { extraMessages }), base);

  // Adding the tool round pushes the estimate over the cap, so the round is
  // dropped and the extra messages are never part of the output.
  const trimmed = trimWorkingMessagesToFit(messages, cap, { extraMessages });
  assert.deepEqual(trimmed, base);
  assert.ok(
    !trimmed.some(
      (m) => typeof m?.content === "object" && m.content?.tools
    )
  );

  // When even the base conversation plus tool definitions exceeds the cap and
  // there is nothing removable left, the trimmer reports failure.
  assert.equal(trimWorkingMessagesToFit(base, cap - 1, { extraMessages }), null);
});

test("trimWorkingMessagesToFit handles empty and invalid input", () => {
  assert.deepEqual(trimWorkingMessagesToFit([], 1_000), []);
  assert.equal(trimWorkingMessagesToFit(null, 1_000), null);
  assert.equal(trimWorkingMessagesToFit("nope", 1_000), null);
});
