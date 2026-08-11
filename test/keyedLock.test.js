import assert from "node:assert/strict";
import test from "node:test";

import { acquireKeyedLock } from "../src/utils/keyedLock.js";

test("serializes work for the same key and releases exactly once", async () => {
  const firstRelease = await acquireKeyedLock("user-1");
  let secondEntered = false;
  const second = acquireKeyedLock("user-1").then((release) => {
    secondEntered = true;
    return release;
  });

  await Promise.resolve();
  assert.equal(secondEntered, false);
  firstRelease();
  firstRelease();
  const secondRelease = await second;
  assert.equal(secondEntered, true);
  secondRelease();
});

test("does not block a different key", async () => {
  const firstRelease = await acquireKeyedLock("user-a");
  const secondRelease = await acquireKeyedLock("user-b");
  assert.equal(typeof secondRelease, "function");
  secondRelease();
  firstRelease();
});
