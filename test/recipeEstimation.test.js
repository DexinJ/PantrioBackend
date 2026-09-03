import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRecipeEstimates,
  estimateAndApplyRecipeMetadata,
  estimateRecipeMetadata,
} from "../src/chat/recipeEstimation.js";
import { recommendRecipes } from "../src/chat/recipeRecommendations.js";

function recipeMarkup(recipe) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    ...recipe,
  })}</script></head></html>`;
}

function fetchedPage(url, recipe) {
  return {
    url,
    text: recipeMarkup({ url, ...recipe }),
    truncated: false,
  };
}

test("estimates missing calories and time, clamps values, and labels confidence", async () => {
  const recipes = [
    {
      title: "Tofu Stir Fry",
      servings: 2,
      ingredients: ["1 block tofu", "2 cups broccoli"],
      instructions: ["Cook the tofu.", "Add the broccoli."],
      warnings: [
        { code: "CALORIES_NOT_PROVIDED", message: "missing" },
        { code: "TIME_NOT_PROVIDED", message: "missing" },
      ],
    },
    {
      title: "Miso Soup",
      servings: 4,
      ingredients: ["3 cups dashi", "2 tablespoons miso"],
      instructions: ["Heat the dashi.", "Stir in the miso."],
      warnings: [],
    },
  ];
  const calls = [];
  const controller = new AbortController();

  const result = await estimateRecipeMetadata(recipes, {
    signal: controller.signal,
    callOpenAI: async (messages, options) => {
      calls.push({ messages, options });
      const payload = JSON.parse(messages[1].content);
      assert.equal(payload.recipes.length, 2);
      assert.equal(payload.recipes[0].title, "Tofu Stir Fry");
      assert.equal(payload.recipes[0].ingredients.length, 2);
      assert.ok(options.signal instanceof AbortSignal);
      return {
        ok: true,
        content: JSON.stringify({
          estimates: [
            { index: 0, caloriesPerServing: 99999, totalMinutes: 999 },
            { index: 1, caloriesPerServing: 60, totalMinutes: 25 },
          ],
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.estimatedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(calls.length, 1);
  assert.equal(result.estimates.get(0).caloriesPerServing, 3000);
  assert.equal(result.estimates.get(0).totalMinutes, 720);
  assert.equal(result.estimates.get(1).caloriesPerServing, 60);
  assert.equal(result.estimates.get(1).totalMinutes, 25);

  assert.equal(applyRecipeEstimates(recipes, result.estimates), 2);
  assert.equal(recipes[0].caloriesPerServing, 3000);
  assert.equal(recipes[0].nutritionConfidence, "ai_estimated");
  assert.equal(recipes[0].timeConfidence, "ai_estimated");
  assert.ok(
    recipes[0].warnings.some((entry) => entry.code === "CALORIES_AI_ESTIMATED")
  );
  assert.ok(
    recipes[0].warnings.some((entry) => entry.code === "TIME_AI_ESTIMATED")
  );
  assert.ok(
    !recipes[0].warnings.some((entry) => entry.code === "CALORIES_NOT_PROVIDED")
  );
  assert.equal(recipes[1].totalMinutes, 25);
  assert.equal(recipes[1].nutritionConfidence, "ai_estimated");
});

test("estimation tolerates malformed, non-JSON, and upstream failures", async () => {
  const recipes = [{ title: "Soup", ingredients: [], instructions: [] }];

  const malformed = await estimateRecipeMetadata(recipes, {
    callOpenAI: async () => ({ ok: true, content: "this is not json" }),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.failedCount, 1);

  const upstream = await estimateRecipeMetadata(recipes, {
    callOpenAI: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(upstream.ok, false);
  assert.equal(upstream.failedCount, 1);

  const empty = await estimateRecipeMetadata(recipes, {
    callOpenAI: async () => ({
      ok: true,
      content: JSON.stringify({ estimates: [] }),
    }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.failedCount, 1);
});

test("estimateAndApplyRecipeMetadata mutates recipes and reports applied count", async () => {
  const recipes = [
    {
      title: "Rice",
      ingredients: ["1 cup rice", "2 cups water"],
      instructions: ["Boil the water.", "Add the rice."],
      warnings: [{ code: "TIME_NOT_PROVIDED", message: "missing" }],
    },
  ];
  const result = await estimateAndApplyRecipeMetadata(recipes, {
    callOpenAI: async () => ({
      ok: true,
      content: JSON.stringify({
        estimates: [{ index: 0, caloriesPerServing: null, totalMinutes: 20 }],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.estimatedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(recipes[0].totalMinutes, 20);
  assert.ok(recipes[0].caloriesPerServing == null);
  assert.equal(recipes[0].timeConfidence, "ai_estimated");
});

test("estimated metadata enriches ranking while calorie and time caps stay soft", async () => {
  const urls = [
    "https://est.example/tofu-bowl",
    "https://est.example/heavy-curry",
    "https://est.example/rich-curry",
    "https://est.example/mystery-soup",
  ];
  const pages = new Map([
    [
      urls[0],
      fetchedPage(urls[0], {
        name: "Tofu Bowl",
        recipeCuisine: ["Japanese"],
        recipeIngredient: ["1 block tofu", "2 cups rice"],
      }),
    ],
    [
      urls[1],
      fetchedPage(urls[1], {
        name: "Heavy Curry",
        recipeCuisine: ["Japanese"],
        recipeIngredient: ["1 pound beef", "3 cups rice"],
      }),
    ],
    [
      urls[2],
      fetchedPage(urls[2], {
        name: "Rich Curry",
        recipeCuisine: ["Japanese"],
        recipeIngredient: ["1 pound beef", "4 cups rice"],
      }),
    ],
    [
      urls[3],
      fetchedPage(urls[3], {
        name: "Mystery Soup",
        recipeCuisine: ["Japanese"],
        recipeIngredient: ["2 cups vegetables", "4 cups water"],
      }),
    ],
  ]);

  const result = await recommendRecipes(
    { cuisines: ["Japanese"], maxCaloriesPerServing: 500, maxPrepMinutes: 30 },
    {},
    {
      estimationEnabled: true,
      estimateMeta: async (recipes) => {
        for (const recipe of recipes) {
          if (recipe.title === "Tofu Bowl") {
            recipe.caloriesPerServing = 350;
            recipe.nutritionConfidence = "ai_estimated";
            recipe.totalMinutes = 20;
            recipe.timeConfidence = "ai_estimated";
            recipe.warnings = [];
          } else if (recipe.title === "Heavy Curry") {
            recipe.caloriesPerServing = 400;
            recipe.nutritionConfidence = "ai_estimated";
            recipe.totalMinutes = 60;
            recipe.timeConfidence = "ai_estimated";
            recipe.warnings = [];
          } else if (recipe.title === "Rich Curry") {
            recipe.caloriesPerServing = 900;
            recipe.nutritionConfidence = "ai_estimated";
            recipe.totalMinutes = 20;
            recipe.timeConfidence = "ai_estimated";
            recipe.warnings = [];
          }
        }
        return {
          ok: true,
          estimatedCount: 3,
          failedCount: recipes.length - 3,
        };
      },
      search: async () => ({
        results: urls.map((link) => ({ title: link, link })),
      }),
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.deepEqual(
    result.recipes.map(({ title }) => title),
    ["Tofu Bowl", "Rich Curry", "Mystery Soup", "Heavy Curry"]
  );
  assert.equal(result.recipes[0].caloriesPerServing, 350);
  assert.equal(result.recipes[0].nutritionConfidence, "ai_estimated");
  assert.equal(result.recipes[0].timeConfidence, "ai_estimated");
  assert.equal(result.meta.estimatedCount, 3);
  assert.equal(result.meta.estimationFailedCount, 1);
  assert.deepEqual(result.meta.filtered, {
    excludedIngredient: 0,
  });
  assert.ok(
    result.warnings.some(
      ({ code }) => code === "METADATA_ESTIMATION_PARTIAL"
    )
  );
});

test("estimation is skipped when disabled or missing, leaving metadata soft", async () => {
  const url = "https://est.example/no-estimate";
  let estimateCalls = 0;

  const disabled = await recommendRecipes(
    { maxPrepMinutes: 30, resultCount: 3 },
    {},
    {
      estimationEnabled: false,
      estimateMeta: async () => {
        estimateCalls += 1;
        return { ok: true, estimatedCount: 0, failedCount: 0 };
      },
      search: async () => ({
        results: [{ title: url, link: url }],
      }),
      fetchPage: async () =>
        fetchedPage(url, {
          name: "No Metadata Meal",
          recipeIngredient: ["2 cups vegetables"],
        }),
    }
  );
  assert.equal(estimateCalls, 0);
  assert.equal(disabled.recipes.length, 1);
  assert.equal(disabled.recipes[0].title, "No Metadata Meal");
  assert.deepEqual(disabled.meta.filtered, { excludedIngredient: 0 });

  const noDependency = await recommendRecipes(
    { maxPrepMinutes: 30, resultCount: 3 },
    {},
    {
      estimationEnabled: true,
      search: async () => ({
        results: [{ title: url, link: url }],
      }),
      fetchPage: async () =>
        fetchedPage(url, {
          name: "No Metadata Meal",
          recipeIngredient: ["2 cups vegetables"],
        }),
    }
  );
  assert.equal(noDependency.recipes.length, 1);
  assert.equal(noDependency.recipes[0].title, "No Metadata Meal");
  assert.deepEqual(noDependency.meta.filtered, { excludedIngredient: 0 });
  assert.equal(noDependency.meta.estimatedCount, 0);
});
