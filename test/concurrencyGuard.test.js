import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createConcurrencyGuard } from "../src/utils/concurrencyGuard.js";

function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.status = (status) => {
    res.statusCode = status;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test("bounds concurrent work and releases capacity exactly once", () => {
  const guard = createConcurrencyGuard({
    maxConcurrent: 1,
    retryAfterSeconds: 7,
    code: "BUSY",
  });
  const first = response();
  let firstStarted = false;
  guard({}, first, () => {
    firstStarted = true;
  });

  const saturated = response();
  let saturatedStarted = false;
  guard({}, saturated, () => {
    saturatedStarted = true;
  });
  assert.equal(firstStarted, true);
  assert.equal(saturatedStarted, false);
  assert.equal(saturated.statusCode, 503);
  assert.equal(saturated.headers["Retry-After"], "7");
  assert.equal(saturated.body.retryAfterMs, 7_000);

  first.emit("finish");
  first.emit("close");
  const afterRelease = response();
  let releasedStarted = false;
  guard({}, afterRelease, () => {
    releasedStarted = true;
  });
  assert.equal(releasedStarted, true);
});

