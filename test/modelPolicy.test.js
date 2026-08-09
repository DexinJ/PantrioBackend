import assert from "node:assert/strict";
import test from "node:test";

import {
  isNonSubscriberModel,
  resolveChatModel,
} from "../src/chat/modelPolicy.js";

test("forces every non-subscriber request to GPT-5 mini", () => {
  assert.deepEqual(
    resolveChatModel({ requestedModel: "gpt-5", isSubscribed: false }),
    {
      ok: true,
      model: "gpt-5-mini",
      requestedModel: "gpt-5",
      wasRestricted: true,
    }
  );
  assert.equal(isNonSubscriberModel("gpt-5-mini"), true);
  assert.equal(isNonSubscriberModel("gpt-5"), false);
});

test("uses GPT-5 mini as the non-subscriber default", () => {
  assert.deepEqual(
    resolveChatModel({ requestedModel: undefined, isSubscribed: false }),
    {
      ok: true,
      model: "gpt-5-mini",
      requestedModel: null,
      wasRestricted: false,
    }
  );
});

test("keeps the existing model choices for subscribed users", () => {
  assert.deepEqual(
    resolveChatModel({ requestedModel: "gpt-4o", isSubscribed: true }),
    {
      ok: true,
      model: "gpt-4o",
      requestedModel: "gpt-4o",
      wasRestricted: false,
    }
  );
  assert.equal(
    resolveChatModel({ requestedModel: null, isSubscribed: true }).model,
    "gpt-5"
  );
});

test("rejects unsupported models for subscribed users", () => {
  const result = resolveChatModel({
    requestedModel: "not-a-model",
    isSubscribed: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "Model not allowed");
});

test("enforces the allowed models of a specific paid plan", () => {
  const limitedPlan = {
    id: "starter",
    defaultModel: "gpt-5-mini",
    allowedModels: ["gpt-5-mini"],
  };
  assert.equal(
    resolveChatModel({ requestedModel: null, isSubscribed: true, plan: limitedPlan })
      .model,
    "gpt-5-mini"
  );
  assert.equal(
    resolveChatModel({
      requestedModel: "gpt-5",
      isSubscribed: true,
      plan: limitedPlan,
    }).ok,
    false
  );
});
