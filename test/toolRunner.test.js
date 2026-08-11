import assert from "node:assert/strict";
import test from "node:test";

import { runToolCalls } from "../src/chat/toolRunner.js";

test("aborted tool execution emits no result frame or model message", async () => {
  const controller = new AbortController();
  const sent = [];
  let finishTool;
  const pending = runToolCalls(
    [
      {
        id: "slow-call",
        function: { name: "slowTool", arguments: "{}" },
      },
    ],
    {
      requestId: "aborted-tool",
      isAuthed: true,
      signal: controller.signal,
      wsSend: (frame) => sent.push(frame),
    },
    {
      tools: {
        slowTool: () =>
          new Promise((resolve) => {
            finishTool = resolve;
          }),
      },
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("deadline"));
  finishTool({ ok: true });

  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(sent, []);
});
