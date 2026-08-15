import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeChatIntent,
  resolveRoundToolPolicy,
  sanitizeRecipeContext,
} from "../src/chat/recipeRequest.js";
import {
  OPENAI_TOOLS,
  RECOMMEND_RECIPES_TOOL,
} from "../src/chat/tools.js";

test("recipe context sanitization bounds and normalizes every client-controlled field", () => {
  const inventory = Array.from({ length: 110 }, (_, index) => ({
    name: ` item-${index}-${"n".repeat(150)} `,
    quantity: ` ${"q".repeat(100)} `,
    ignored: "do not retain",
  }));
  const selectedIngredients = [
    " Milk ",
    "milk",
    ...Array.from({ length: 40 }, (_, index) => `ingredient-${index}`),
  ];
  const cuisineScores = Object.fromEntries(
    Array.from({ length: 55 }, (_, index) => [
      ` cuisine-${index} `,
      index % 2 === 0 ? 99 : -99,
    ])
  );

  const context = sanitizeRecipeContext({
    inventory,
    selectedIngredients,
    preferences: {
      schemaVersion: 999,
      explicit: {
        preferredCuisines: Array.from(
          { length: 25 },
          (_, index) => ` cuisine-${index} `
        ),
        dislikedCuisines: [" French ", "french", ""],
        allergens: [" Peanuts "],
        dietaryPatterns: [" Vegetarian "],
        excludedIngredients: [" Anchovies "],
        dislikedIngredients: [" Olives "],
        preferredEnergy: "invalid",
        maxCaloriesPerServing: 9999,
        maxPrepMinutes: -10,
        defaultServings: 99,
        ignored: "drop me",
      },
      learned: {
        cuisineScores,
        ingredientScores: { spinach: 2.5, invalid: "nope" },
      },
      personalization: { enabled: false, learnFromActivity: true },
      ignored: "drop me",
    },
    ignored: "drop me",
  });

  assert.equal(context.inventory.length, 100);
  assert.equal(context.inventory[0].name.length, 120);
  assert.equal(context.inventory[0].quantity.length, 80);
  assert.deepEqual(Object.keys(context.inventory[0]), ["name", "quantity"]);
  assert.equal(context.selectedIngredients.length, 30);
  assert.equal(context.selectedIngredients[0], "Milk");
  assert.equal(context.selectedIngredients.includes("milk"), false);

  assert.equal(context.preferences.schemaVersion, 1);
  assert.equal(context.preferences.explicit.preferredCuisines.length, 20);
  assert.deepEqual(context.preferences.explicit.dislikedCuisines, ["French"]);
  assert.deepEqual(context.preferences.explicit.allergens, ["Peanuts"]);
  assert.deepEqual(context.preferences.explicit.dietaryPatterns, ["Vegetarian"]);
  assert.deepEqual(context.preferences.explicit.excludedIngredients, ["Anchovies"]);
  assert.deepEqual(context.preferences.explicit.dislikedIngredients, ["Olives"]);
  assert.equal(context.preferences.explicit.preferredEnergy, "any");
  assert.equal(context.preferences.explicit.maxCaloriesPerServing, 2500);
  assert.equal(context.preferences.explicit.maxPrepMinutes, 5);
  assert.equal(context.preferences.explicit.defaultServings, 12);
  assert.equal(Object.keys(context.preferences.learned.cuisineScores).length, 50);
  assert.equal(context.preferences.learned.cuisineScores["cuisine-0"], 10);
  assert.equal(context.preferences.learned.cuisineScores["cuisine-1"], -10);
  assert.deepEqual(context.preferences.learned.ingredientScores, { spinach: 2.5 });
  assert.deepEqual(context.preferences.personalization, {
    enabled: false,
    learnFromActivity: true,
  });
  assert.equal("ignored" in context, false);
  assert.equal("ignored" in context.preferences, false);
  assert.equal("ignored" in context.preferences.explicit, false);
});

test("invalid recipe context fails closed to bounded defaults", () => {
  assert.deepEqual(sanitizeRecipeContext(["not", "an", "object"]), {
    inventory: [],
    selectedIngredients: [],
    preferences: {
      schemaVersion: 1,
      explicit: {
        preferredCuisines: [],
        dislikedCuisines: [],
        allergens: [],
        dietaryPatterns: [],
        excludedIngredients: [],
        dislikedIngredients: [],
        preferredEnergy: "any",
        maxCaloriesPerServing: null,
        maxPrepMinutes: null,
        defaultServings: 2,
      },
      learned: { cuisineScores: {}, ingredientScores: {} },
      personalization: { enabled: true, learnFromActivity: false },
    },
  });
});

test("round policy forces exactly one recipe tool call and removes tools from continuation", () => {
  assert.equal(normalizeChatIntent("recipe_recommendation"), "recipe_recommendation");
  assert.equal(normalizeChatIntent("anything-else"), "chat");

  const chat = resolveRoundToolPolicy({ intent: "chat", round: 0 });
  assert.strictEqual(chat.tools, OPENAI_TOOLS);
  assert.equal(chat.toolChoice, "auto");
  assert.equal(chat.parallelToolCalls, false);

  const firstRecipeRound = resolveRoundToolPolicy({
    intent: "recipe_recommendation",
    round: 0,
  });
  assert.equal(firstRecipeRound.tools.length, 1);
  assert.strictEqual(firstRecipeRound.tools[0], RECOMMEND_RECIPES_TOOL);
  assert.deepEqual(firstRecipeRound.toolChoice, {
    type: "function",
    function: { name: "recommendRecipes" },
  });
  assert.equal(firstRecipeRound.parallelToolCalls, false);

  const continuation = resolveRoundToolPolicy({
    intent: "recipe_recommendation",
    round: 1,
  });
  assert.deepEqual(continuation, {
    tools: [],
    toolChoice: undefined,
    parallelToolCalls: undefined,
  });
});
