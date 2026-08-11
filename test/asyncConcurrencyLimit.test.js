import assert from "node:assert/strict";
import test from "node:test";

import { createAsyncConcurrencyLimit } from "../src/utils/asyncConcurrencyLimit.js";

test("async concurrency limit bounds work and releases after failure", async () => {
  const runLimited = createAsyncConcurrencyLimit(2);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, index) =>
    runLimited(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (index === 2) throw new Error("expected");
      return index;
    })
  );
  const results = await Promise.allSettled(tasks);
  assert.equal(peak, 2);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 5);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("a new arrival cannot barge ahead of a released waiter", async () => {
  const runLimited = createAsyncConcurrencyLimit(1);
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let peak = 0;
  const order = [];
  const track = (label, waitFor = null) => runLimited(async () => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(label);
    if (waitFor) await waitFor;
    else await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  });

  const first = track("first", firstGate);
  const waiting = track("waiting");
  releaseFirst();
  const barging = new Promise((resolve, reject) => {
    queueMicrotask(() => track("new-arrival").then(resolve, reject));
  });

  await Promise.all([first, waiting, barging]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["first", "waiting", "new-arrival"]);
});
