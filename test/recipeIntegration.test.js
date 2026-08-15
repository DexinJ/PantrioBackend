import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import express from "express";

import {
  createRecommendRecipesTool,
  TOOLS,
} from "../src/chat/tools.js";
import { RecipeRecommendationError } from "../src/chat/recipeRecommendations.js";
import {
  attachRoutes,
  createRecipeRecommendationHandler,
} from "../src/http/routes.js";

function request({ uid = "recipe-user", body = {} } = {}) {
  const req = new EventEmitter();
  req.body = body;
  if (uid) req.authenticatedUser = { uid };
  return req;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.body = null;
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

test("recommendRecipes tool passes trusted context and bounded network dependencies", async () => {
  const controller = new AbortController();
  const overrides = { preferredCuisines: ["Thai"] };
  const recipeContext = { inventory: ["tofu"] };
  const search = async () => ({ results: [] });
  const fetchPage = async () => ({ text: "", url: "https://example.com" });
  let received;
  const tool = createRecommendRecipesTool({
    search,
    fetchPage,
    recommendRecipesFn: async (...args) => {
      received = args;
      return { recipes: [], warnings: [] };
    },
  });

  const result = await tool(overrides, {
    recipeContext,
    signal: controller.signal,
  });

  assert.deepEqual(result, { recipes: [], warnings: [] });
  assert.equal(received[0], overrides);
  assert.equal(received[1], recipeContext);
  assert.equal(received[2].search, search);
  assert.equal(received[2].fetchPage, fetchPage);
  assert.equal(received[2].signal, controller.signal);
  assert.equal(typeof TOOLS.recommendRecipes, "function");
});

test("recipe recommendation route is authenticated, rate limited, and concurrency bounded", () => {
  const app = express();
  attachRoutes(app);
  const layer = app.router.stack.find(
    (candidate) => candidate.route?.path === "/api/recipes/recommend"
  );

  assert.equal(layer?.route?.methods?.post, true);
  assert.equal(layer.route.stack.length, 4);
  assert.equal(layer.route.stack[0].handle.name, "authenticateRequest");
  assert.equal(layer.route.stack[2].handle.name, "concurrencyGuard");
  assert.equal(layer.route.stack[3].handle.name, "recipeRecommendationHandler");
});

test("recipe recommendation handler forwards the parity payload and dependencies", async () => {
  const overrides = { energyPreference: "light" };
  const recipeContext = {
    inventory: [
      { name: " chicken ", quantity: "1 lb" },
      { name: "broccoli", quantity: "2 cups" },
    ],
    preferences: { explicit: { maxPrepMinutes: 30 } },
    untrustedExtra: { secret: "must not reach the engine" },
  };
  const expected = { recipes: [{ title: "Dinner" }], warnings: [] };
  const search = async () => ({ results: [] });
  const fetchPage = async () => ({ text: "", url: "https://example.com" });
  let received;
  const handler = createRecipeRecommendationHandler({
    search,
    fetchPage,
    recommendRecipesFn: async (...args) => {
      received = args;
      return expected;
    },
  });
  const req = request({ body: { overrides, recipeContext } });
  const res = response();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, expected);
  assert.equal(received[0], overrides);
  assert.deepEqual(received[1].inventory, [
    { name: "chicken", quantity: "1 lb" },
    { name: "broccoli", quantity: "2 cups" },
  ]);
  assert.equal(received[1].preferences.explicit.maxPrepMinutes, 30);
  assert.equal("untrustedExtra" in received[1], false);
  assert.equal(received[2].search, search);
  assert.equal(received[2].fetchPage, fetchPage);
  assert.equal(received[2].signal instanceof AbortSignal, true);
  assert.equal(received[2].signal.aborted, false);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("recipe recommendation handler rejects unauthenticated and malformed payloads", async () => {
  let calls = 0;
  const handler = createRecipeRecommendationHandler({
    search: async () => ({ results: [] }),
    fetchPage: async () => ({ text: "", url: "https://example.com" }),
    recommendRecipesFn: async () => {
      calls += 1;
      return { recipes: [] };
    },
  });
  const unauthenticated = response();
  await handler(
    request({ uid: null, body: { overrides: {}, recipeContext: {} } }),
    unauthenticated
  );
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.body.code, "AUTH_REQUIRED");

  const malformed = response();
  await handler(
    request({ body: { overrides: [], recipeContext: {} } }),
    malformed
  );
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.code, "INVALID_RECIPE_REQUEST");
  assert.equal(calls, 0);
});

test("recipe recommendation handler maps engine timeouts without leaking details", async (t) => {
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalConsoleError;
  });
  const handler = createRecipeRecommendationHandler({
    search: async () => ({ results: [] }),
    fetchPage: async () => ({ text: "", url: "https://example.com" }),
    recommendRecipesFn: async () => {
      throw new RecipeRecommendationError("TIMEOUT", "private timeout detail");
    },
  });
  const res = response();

  await handler(
    request({ body: { overrides: {}, recipeContext: {} } }),
    res
  );

  assert.equal(res.statusCode, 504);
  assert.deepEqual(res.body, {
    code: "RECIPE_RECOMMENDATION_TIMEOUT",
    error: "Recipe recommendation timed out.",
  });
  assert.doesNotMatch(JSON.stringify(res.body), /private timeout detail/);
});

test("disconnecting a recipe recommendation aborts engine work without a response", async () => {
  let receivedSignal;
  const handler = createRecipeRecommendationHandler({
    search: async () => ({ results: [] }),
    fetchPage: async () => ({ text: "", url: "https://example.com" }),
    recommendRecipesFn: async (_overrides, _context, { signal }) => {
      receivedSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new RecipeRecommendationError("ABORTED", "cancelled")),
          { once: true }
        );
      });
    },
  });
  const req = request({ body: { overrides: {}, recipeContext: {} } });
  const res = response();
  const pending = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));

  req.emit("aborted");
  await pending;

  assert.equal(receivedSignal.aborted, true);
  assert.equal(res.headersSent, false);
  assert.equal(res.body, null);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});
