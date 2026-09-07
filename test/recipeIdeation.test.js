import assert from "node:assert/strict";
import test from "node:test";

import {
  generateRecipeIdeas,
  MAX_IDEAS,
  normalizeIdeas,
  recipeIdeationEnabled,
} from "../src/chat/recipeIdeation.js";

test("recipe ideation exposes a boolean enable flag", () => {
  assert.equal(typeof recipeIdeationEnabled(), "boolean");
});

test("normalizeIdeas validates, deduplicates, and bounds ideas", () => {
  const input = {
    ideas: [
      {
        dish: "Yogurt chicken",
        query: "yogurt chicken recipe",
        coreIngredients: ["chicken", "yogurt", "garlic"],
      },
      // Duplicate query must be dropped.
      {
        dish: "Yogurt chicken again",
        query: "yogurt chicken recipe",
        coreIngredients: ["chicken"],
      },
      // Invalid entries must be dropped.
      { dish: "", query: "missing name recipe", coreIngredients: ["egg"] },
      { dish: "No core ingredients", query: "empty core recipe", coreIngredients: [] },
      {
        dish: "Tomato egg stir fry",
        query: "tomato egg stir fry recipe",
        coreIngredients: ["tomato", "egg"],
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        dish: `Dish ${index}`,
        query: `dish ${index} recipe`,
        coreIngredients: ["salt"],
      })),
    ],
  };

  const ideas = normalizeIdeas(input);

  assert.equal(ideas.length, MAX_IDEAS);
  assert.equal(ideas[0].dish, "Yogurt chicken");
  assert.deepEqual(ideas[0].coreIngredients, ["chicken", "yogurt", "garlic"]);
  assert.ok(ideas.some((idea) => idea.dish === "Tomato egg stir fry"));
  assert.ok(!ideas.some((idea) => idea.dish === "No core ingredients"));
});

test("generateRecipeIdeas parses a fenced JSON response into ideas", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '```json\n{"ideas":[{"dish":"Tomato egg stir fry","query":"tomato egg stir fry recipe","coreIngredients":["tomato","egg"]}]}\n```',
            },
          },
        ],
      }),
      { status: 200 }
    );

  try {
    const result = await generateRecipeIdeas({
      inventory: ["tomato", "egg"],
      mealType: "dinner",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ideas.length, 1);
    assert.equal(result.ideas[0].dish, "Tomato egg stir fry");
    assert.match(result.ideas[0].query, /tomato egg/i);
    assert.deepEqual(result.ideas[0].coreIngredients, ["tomato", "egg"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateRecipeIdeas fails closed with no ideas", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  try {
    const result = await generateRecipeIdeas({ inventory: [] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ideas, []);
    assert.equal(typeof result.error, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
