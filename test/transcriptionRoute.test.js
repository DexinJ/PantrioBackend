import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import {
  allowTranscriptionCors,
  attachRoutes,
} from "../src/http/routes.js";

function response() {
  return {
    headers: new Map(),
    statusCode: 200,
    ended: false,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test("transcription CORS answers browser preflight before authentication", () => {
  const res = response();
  let nextCalled = false;

  allowTranscriptionCors(
    { method: "OPTIONS" },
    res,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(nextCalled, false);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    res.headers.get("access-control-allow-headers"),
    "Authorization, Content-Type"
  );
});

test("transcription POST receives CORS headers and continues to auth", () => {
  const res = response();
  let nextCalled = false;

  allowTranscriptionCors(
    { method: "POST" },
    res,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, true);
  assert.equal(res.ended, false);
  assert.equal(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

test("transcription route keeps CORS before authentication and upload work", () => {
  const app = express();
  attachRoutes(app);
  const postLayer = app.router.stack.find(
    (candidate) =>
      candidate.route?.path === "/api/transcriptions" &&
      candidate.route?.methods?.post
  );
  const optionLayer = app.router.stack.find(
    (candidate) =>
      candidate.route?.path === "/api/transcriptions" &&
      candidate.route?.methods?.options
  );

  assert.equal(optionLayer?.route?.stack[0]?.handle, allowTranscriptionCors);
  assert.equal(postLayer?.route?.stack[0]?.handle, allowTranscriptionCors);
  assert.equal(postLayer?.route?.stack[1]?.handle.name, "authenticateRequest");
  assert.equal(postLayer?.route?.stack[4]?.handle.name, "handleAudioUpload");
});
