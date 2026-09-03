import assert from "node:assert/strict";
import test from "node:test";

import {
  RecipeRecommendationError,
  recommendRecipes,
} from "../src/chat/recipeRecommendations.js";
import {
  parseIsoDurationMinutes,
  parseRecipeJsonLd,
} from "../src/chat/recipeJsonLd.js";

function recipeMarkup(recipe) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    recipeYield: "4 servings",
    recipeIngredient: ["1 teaspoon salt"],
    recipeInstructions: [{ "@type": "HowToStep", text: "Cook it." }],
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

test("parses and normalizes nested Recipe JSON-LD without evaluating markup", () => {
  const html = `
    <script type="application/ld+json">{not valid json}</script>
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", name: "Example" },
          {
            "@type": ["Thing", "Recipe"],
            name: "Thai &amp; Basil Chicken",
            url: "/recipes/thai-basil",
            publisher: { "@type": "Organization", name: "Test Kitchen" },
            description: "A <b>fast</b> dinner.",
            recipeCuisine: ["Thai", "Asian"],
            recipeCategory: "Dinner, Main Course",
            suitableFor: "https://schema.org/GlutenFreeDiet",
            recipeYield: "4 servings",
            prepTime: "PT15M",
            cookTime: "PT20M",
            totalTime: "PT35M",
            nutrition: { calories: "385 calories" },
            recipeIngredient: [
              "1 lb chicken breast",
              "2 cups Thai basil",
              "1 tablespoon fish sauce",
            ],
            recipeInstructions: [
              {
                "@type": "HowToSection",
                name: "Cook",
                itemListElement: [
                  { "@type": "HowToStep", text: "Brown the chicken." },
                  { "@type": "HowToStep", text: "Fold in <b>basil</b>." },
                ],
              },
            ],
          },
        ],
      })}
    </script>`;

  const parsed = parseRecipeJsonLd(html, {
    pageUrl: "https://recipes.example.test/start",
  });

  assert.equal(parsed.recipes.length, 1);
  assert.equal(parsed.diagnostics.malformedScripts, 1);
  assert.deepEqual(parsed.recipes[0], {
    title: "Thai & Basil Chicken",
    url: "https://recipes.example.test/recipes/thai-basil",
    source: "Test Kitchen",
    description: "A fast dinner.",
    cuisines: ["Thai", "Asian"],
    mealTypes: ["Dinner", "Main Course"],
    diets: ["Gluten Free"],
    servings: 4,
    prepMinutes: 15,
    cookMinutes: 20,
    totalMinutes: 35,
    caloriesPerServing: 385,
    nutritionConfidence: "publisher_provided",
    timeConfidence: "publisher_provided",
    ingredients: [
      "1 lb chicken breast",
      "2 cups Thai basil",
      "1 tablespoon fish sauce",
    ],
    instructions: ["Brown the chicken.", "Fold in basil."],
    warnings: [],
  });
  assert.equal(parseIsoDurationMinutes("1 hr 30 min"), 90);
  assert.equal(parseIsoDurationMinutes("PT1H5M"), 65);
  assert.equal(parseIsoDurationMinutes("not a duration"), null);
});

test("hard-excludes trusted ingredients while soft-ranking calorie and time caps", async () => {
  const urls = [
    "https://thai.example/light",
    "https://american.example/burger",
    "https://thai.example/peanut-noodles",
    "https://veggie.example/tofu",
    "https://curry.example/green-curry",
  ];
  const pages = new Map([
    [
      urls[0],
      fetchedPage(urls[0], {
        name: "Thai Basil Chicken",
        recipeCuisine: ["Thai"],
        totalTime: "PT25M",
        nutrition: { calories: "350 kcal" },
        recipeIngredient: [
          "1 pound chicken breasts",
          "2 cups Thai basil leaves",
          "2 cups cooked rice",
        ],
      }),
    ],
    [
      urls[1],
      fetchedPage(urls[1], {
        name: "American Cheeseburger",
        recipeCuisine: ["American"],
        totalTime: "PT20M",
        nutrition: { calories: "650 calories" },
        recipeIngredient: ["1 pound beef", "4 burger buns", "4 slices cheese"],
      }),
    ],
    [
      urls[2],
      fetchedPage(urls[2], {
        name: "Thai Peanut Noodles",
        recipeCuisine: ["Thai"],
        totalTime: "PT20M",
        nutrition: { calories: "420 calories" },
        recipeIngredient: ["8 ounces noodles", "1/2 cup peanut sauce"],
      }),
    ],
    [
      urls[3],
      fetchedPage(urls[3], {
        name: "Broccoli Tofu Bowl",
        recipeCuisine: ["Asian"],
        totalTime: "PT30M",
        nutrition: {},
        recipeIngredient: ["1 head broccoli", "14 ounces tofu"],
      }),
    ],
    [
      urls[4],
      fetchedPage(urls[4], {
        name: "Thai Green Vegetable Curry",
        recipeCuisine: ["Thai"],
        totalTime: "PT40M",
        nutrition: { calories: "450 calories" },
        recipeIngredient: ["1 head broccoli", "1 bell pepper", "coconut milk"],
      }),
    ],
  ]);
  const searchCalls = [];
  const fetchCalls = [];

  const result = await recommendRecipes(
    {
      cuisines: ["Asian"],
      energyPreference: "light",
      maxCaloriesPerServing: 500,
      maxPrepMinutes: 30,
      resultCount: 3,
    },
    {
      inventory: ["chicken breast", "Thai basil", "rice", "broccoli"],
      preferences: {
        explicit: {
          allergens: ["peanut"],
          preferredCuisines: ["American"],
          preferredEnergy: "hearty",
          maxCaloriesPerServing: 700,
          excludedIngredients: ["mushrooms"],
        },
      },
    },
    {
      search: async (args, context) => {
        searchCalls.push({ args, context });
        return {
          results: urls.map((link) => ({ title: link, link, snippet: "" })),
        };
      },
      fetchPage: async (url, options) => {
        fetchCalls.push({ url, options });
        return pages.get(url);
      },
    }
  );

  assert.ok(searchCalls.length <= 2);
  assert.match(searchCalls[0].args.query, /Asian/i);
  assert.match(searchCalls[0].args.query, /under 500 calories per serving/i);
  assert.ok(searchCalls[0].context.signal instanceof AbortSignal);
  assert.equal(fetchCalls.length, 5);
  assert.ok(fetchCalls.every(({ options }) => options.maxBytes <= 512 * 1024));

  assert.deepEqual(
    result.recipes.map(({ title }) => title),
    [
      "Thai Basil Chicken",
      "Thai Green Vegetable Curry",
      "Broccoli Tofu Bowl",
    ]
  );
  assert.deepEqual(result.recipes[0].usedIngredients, [
    "chicken breast",
    "Thai basil",
    "rice",
  ]);
  assert.equal(result.recipes[0].caloriesPerServing, 350);
  assert.equal(result.recipes[0].nutritionConfidence, "publisher_provided");
  assert.match(result.recipes[0].whyRecommended, /Asian preference/i);
  assert.deepEqual(result.meta.filtered, {
    excludedIngredient: 1,
  });
  assert.equal(result.meta.applied.maxCaloriesPerServing, 500);
  assert.deepEqual(result.meta.applied.cuisines, ["Asian"]);
  assert.ok(
    result.warnings.some(
      ({ code }) => code === "ALLERGEN_CROSS_CONTACT_NOT_VERIFIED"
    )
  );
});

test("bounds network work, deduplicates URLs, and diversifies equal-scoring sources", async () => {
  const searchResults = [
    "https://one.example/r1?utm_source=test",
    "https://one.example/r1",
    "https://one.example/r2",
    "https://one.example/r3",
    "https://two.example/r4",
    "https://three.example/r5",
    "https://four.example/r6",
    "https://five.example/r7",
    "https://six.example/r8",
    "https://seven.example/r9",
    "https://eight.example/r10",
    "https://nine.example/r11",
  ];
  let searches = 0;
  let fetches = 0;
  let activeFetches = 0;
  let peakFetches = 0;

  const result = await recommendRecipes(
    { resultCount: 6 },
    {},
    {
      search: async () => {
        searches += 1;
        return {
          results: searchResults.map((link) => ({ title: link, link })),
        };
      },
      fetchPage: async (url) => {
        fetches += 1;
        activeFetches += 1;
        peakFetches = Math.max(peakFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeFetches -= 1;
        return fetchedPage(url, {
          name: `Recipe ${new URL(url).pathname}`,
          recipeCuisine: ["International"],
          totalTime: "PT30M",
          nutrition: { calories: "400 calories" },
          recipeIngredient: ["1 cup vegetables"],
        });
      },
      limits: {
        maxSearchQueries: 999,
        searchResultsPerQuery: 10,
        maxPages: 999,
        fetchConcurrency: 999,
        pageMaxBytes: Number.MAX_SAFE_INTEGER,
      },
    }
  );

  assert.ok(searches <= 2);
  assert.ok(fetches <= 12);
  assert.ok(peakFetches <= 3);
  assert.equal(result.recipes.length, 6);
  assert.notEqual(
    new URL(result.recipes[0].url).hostname,
    new URL(result.recipes[1].url).hostname
  );
  assert.equal(
    new Set(result.recipes.map(({ url }) => url.replace(/\?.*$/, ""))).size,
    result.recipes.length
  );
});

test("keeps unknown nutrition with an explicit warning when no calorie cap applies", async () => {
  const url = "https://recipes.example/unknown-nutrition";
  const result = await recommendRecipes(
    { energyPreference: "light", resultCount: 1 },
    {},
    {
      search: async () => ({ results: [{ title: "Recipe", link: url }] }),
      fetchPage: async () =>
        fetchedPage(url, {
          name: "Vegetable Soup",
          totalTime: "PT20M",
          recipeIngredient: ["2 cups vegetables", "4 cups water"],
        }),
    }
  );

  assert.equal(result.recipes.length, 1);
  assert.equal(result.recipes[0].caloriesPerServing, null);
  assert.equal(result.recipes[0].nutritionConfidence, "unknown");
  assert.ok(
    result.recipes[0].warnings.some(
      ({ code }) => code === "CALORIES_NOT_PROVIDED"
    )
  );
});

test("prioritizes selected and must-use ingredients without treating them as exclusions", async () => {
  const requestedUrl = "https://vegetables.example/zucchini-ginger";
  const otherUrl = "https://japanese.example/chicken";
  const pages = new Map([
    [
      requestedUrl,
      fetchedPage(requestedUrl, {
        name: "Zucchini Ginger Skillet",
        recipeCuisine: ["International"],
        totalTime: "PT30M",
        nutrition: { calories: "400 calories" },
        recipeIngredient: ["2 zucchini", "1 tablespoon fresh ginger"],
      }),
    ],
    [
      otherUrl,
      fetchedPage(otherUrl, {
        name: "Japanese Chicken",
        recipeCuisine: ["Japanese"],
        totalTime: "PT20M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["1 pound chicken", "1 tablespoon soy sauce"],
      }),
    ],
  ]);
  const queries = [];

  const result = await recommendRecipes(
    {
      preferredCuisines: ["Japanese"],
      mustUseIngredients: ["ginger"],
      maxCaloriesPerServing: 2_500,
      maxPrepMinutes: 480,
      servings: 12,
      resultCount: 2,
    },
    {
      inventory: ["chicken", "zucchini"],
      selectedIngredients: ["zucchini"],
    },
    {
      search: async ({ query }) => {
        queries.push(query);
        return {
          results: [requestedUrl, otherUrl].map((link) => ({ link })),
        };
      },
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.match(queries[0], /^using zucchini ginger\b/i);
  assert.deepEqual(
    result.recipes.map(({ title }) => title),
    ["Zucchini Ginger Skillet", "Japanese Chicken"]
  );
  assert.deepEqual(result.recipes[0].matchedRequestedIngredients, [
    "zucchini",
    "ginger",
  ]);
  assert.deepEqual(result.recipes[1].unmatchedRequestedIngredients, [
    "zucchini",
    "ginger",
  ]);
  assert.deepEqual(result.meta.applied.requestedIngredients, [
    "zucchini",
    "ginger",
  ]);
  assert.equal(result.meta.applied.maxCaloriesPerServing, 2_500);
  assert.equal(result.meta.applied.maxPrepMinutes, 480);
  assert.equal(result.meta.applied.servings, 12);
  assert.equal(result.meta.candidatesAfterHardConstraints, 2);
});

test("disabling personalization ignores saved soft defaults but preserves safety constraints", async () => {
  const safeUrl = "https://american.example/hearty-stew";
  const allergenUrl = "https://thai.example/peanut-stew";
  const pages = new Map([
    [
      safeUrl,
      fetchedPage(safeUrl, {
        name: "American Hearty Stew",
        recipeCuisine: ["American"],
        totalTime: "PT90M",
        nutrition: { calories: "800 calories" },
        recipeIngredient: ["1 pound beef", "2 carrots"],
      }),
    ],
    [
      allergenUrl,
      fetchedPage(allergenUrl, {
        name: "Thai Peanut Stew",
        recipeCuisine: ["Thai"],
        totalTime: "PT20M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["1 cup peanuts", "2 carrots"],
      }),
    ],
  ]);
  const queries = [];

  const result = await recommendRecipes(
    { resultCount: 2 },
    {
      preferences: {
        explicit: {
          preferredCuisines: ["Thai"],
          preferredEnergy: "light",
          maxCaloriesPerServing: 400,
          maxPrepMinutes: 10,
          defaultServings: 2,
          allergens: ["Peanut allergy"],
          excludedIngredients: ["mushrooms"],
        },
        learned: { cuisineScores: { Thai: 10 } },
        personalization: { enabled: false },
      },
    },
    {
      search: async ({ query }) => {
        queries.push(query);
        return {
          results: [safeUrl, allergenUrl].map((link) => ({ link })),
        };
      },
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.equal(result.recipes.length, 1);
  assert.equal(result.recipes[0].title, "American Hearty Stew");
  assert.ok(queries.every((query) => !/Thai|light|under 400|10 minutes/i.test(query)));
  assert.deepEqual(result.meta.applied.cuisines, []);
  assert.equal(result.meta.applied.energyPreference, "any");
  assert.equal(result.meta.applied.maxCaloriesPerServing, null);
  assert.equal(result.meta.applied.maxPrepMinutes, null);
  assert.equal(result.meta.applied.servings, null);
  assert.equal(result.meta.applied.personalizationEnabled, false);
  assert.equal(result.meta.filtered.excludedIngredient, 1);
  assert.ok(
    result.warnings.some(
      ({ code }) => code === "ALLERGEN_CROSS_CONTACT_NOT_VERIFIED"
    )
  );
});

test("softly demotes disliked ingredients while keeping the recipe eligible", async () => {
  const dislikedUrl = "https://one.example/cilantro-rice";
  const preferredUrl = "https://two.example/parsley-rice";
  const pages = new Map([
    [
      dislikedUrl,
      fetchedPage(dislikedUrl, {
        name: "Cilantro Rice Bowl",
        recipeCuisine: ["International"],
        totalTime: "PT25M",
        nutrition: { calories: "400 calories" },
        recipeIngredient: ["2 cups rice", "1 cup cilantro"],
      }),
    ],
    [
      preferredUrl,
      fetchedPage(preferredUrl, {
        name: "Parsley Rice Bowl",
        recipeCuisine: ["International"],
        totalTime: "PT25M",
        nutrition: { calories: "400 calories" },
        recipeIngredient: ["2 cups rice", "1 cup parsley"],
      }),
    ],
  ]);

  const result = await recommendRecipes(
    { resultCount: 2 },
    {
      preferences: {
        explicit: { dislikedIngredients: ["cilantro"] },
        personalization: { enabled: true },
      },
    },
    {
      search: async () => ({
        results: [dislikedUrl, preferredUrl].map((link) => ({ link })),
      }),
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.deepEqual(
    result.recipes.map(({ title }) => title),
    ["Parsley Rice Bowl", "Cilantro Rice Bowl"]
  );
  assert.deepEqual(result.recipes[0].matchedDislikedIngredients, []);
  assert.deepEqual(result.recipes[1].matchedDislikedIngredients, ["cilantro"]);
  assert.equal(result.recipes[0].dislikedIngredientPenalty, 0);
  assert.equal(result.recipes[1].dislikedIngredientPenalty, 0.06);
  assert.ok(result.recipes[1].score < result.recipes[0].score);
  assert.equal(result.meta.candidatesAfterHardConstraints, 2);
  assert.equal(result.meta.applied.dislikedIngredientCount, 1);
});

test("softly demotes recipes over or missing the requested prep-time ceiling", async () => {
  const withinUrl = "https://time.example/within";
  const overUrl = "https://time.example/over";
  const unknownUrl = "https://time.example/unknown";
  const pages = new Map([
    [
      withinUrl,
      fetchedPage(withinUrl, {
        name: "Quick Vegetables",
        totalTime: "PT25M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["2 cups vegetables"],
      }),
    ],
    [
      overUrl,
      fetchedPage(overUrl, {
        name: "Slow Vegetables",
        totalTime: "PT45M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["2 cups vegetables"],
      }),
    ],
    [
      unknownUrl,
      fetchedPage(unknownUrl, {
        name: "Unknown-Time Vegetables",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["2 cups vegetables"],
      }),
    ],
  ]);

  const result = await recommendRecipes(
    { maxPrepMinutes: 30, resultCount: 3 },
    {},
    {
      search: async () => ({
        results: [withinUrl, overUrl, unknownUrl].map((link) => ({ link })),
      }),
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.deepEqual(
    result.recipes.map(({ title }) => title),
    ["Quick Vegetables", "Slow Vegetables", "Unknown-Time Vegetables"]
  );
  assert.deepEqual(result.meta.filtered, {
    excludedIngredient: 0,
  });
  assert.ok(result.recipes[0].score > result.recipes[1].score);
  assert.ok(result.recipes[1].score > result.recipes[2].score);
  assert.equal(result.meta.applied.maxPrepMinutes, 30);
});

test("honors cancellation even when an injected search ignores the signal", async () => {
  const controller = new AbortController();
  let searchStarted;
  const started = new Promise((resolve) => {
    searchStarted = resolve;
  });
  const recommendation = recommendRecipes(
    {},
    {},
    {
      signal: controller.signal,
      search: async () => {
        searchStarted();
        return new Promise(() => {});
      },
      fetchPage: async () => {
        throw new Error("should not fetch");
      },
    }
  );

  await started;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(
    recommendation,
    (error) =>
      error instanceof RecipeRecommendationError && error.code === "ABORTED"
  );
});

test("maxResultCount caps the requested result count", async () => {
  const urls = Array.from(
    { length: 12 },
    (_, index) => `https://cap.example/r${index}`
  );
  const result = await recommendRecipes(
    { resultCount: 10 },
    {},
    {
      maxResultCount: 6,
      search: async () => ({
        results: urls.map((link) => ({ title: link, link })),
      }),
      fetchPage: async (url) =>
        fetchedPage(url, {
          name: `Recipe ${new URL(url).pathname}`,
          totalTime: "PT30M",
          nutrition: { calories: "400 calories" },
          recipeIngredient: ["1 cup vegetables"],
        }),
      limits: { maxSearchQueries: 2, searchResultsPerQuery: 12, maxPages: 12 },
    }
  );

  assert.equal(result.recipes.length, 6);
});

test("skill, cooking method, and ingredient count shape the search queries", async () => {
  const queries = [];
  const url = "https://queries.example/air-fryer";
  await recommendRecipes(
    {
      skillLevel: "beginner",
      cookingMethod: "air_fryer",
      maxIngredients: 5,
      resultCount: 1,
    },
    {},
    {
      search: async (args) => {
        queries.push(args.query);
        return { results: [{ title: "Air Fryer Chicken", link: url }] };
      },
      fetchPage: async () =>
        fetchedPage(url, {
          name: "Air Fryer Chicken",
          totalTime: "PT25M",
          nutrition: { calories: "320 calories" },
          recipeIngredient: ["chicken", "salt", "pepper", "oil", "paprika"],
        }),
    }
  );

  const joined = queries.join(" ");
  assert.match(joined, /\beasy\b/i);
  assert.match(joined, /\bair fryer\b/i);
  assert.match(joined, /under 5 ingredients/i);
});

test("meal type filters proven mismatches but keeps unknown-category fallbacks", async () => {
  const breakfastUrl = "https://meal.example/muffins";
  const dinnerUrl = "https://meal.example/chicken-dinner";
  const unknownUrl = "https://meal.example/spinach-omelette";
  const pages = new Map([
    [
      breakfastUrl,
      fetchedPage(breakfastUrl, {
        name: "Blueberry Muffins",
        recipeCategory: ["Breakfast"],
        totalTime: "PT25M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["flour", "blueberries"],
      }),
    ],
    [
      dinnerUrl,
      fetchedPage(dinnerUrl, {
        name: "Chicken Dinner",
        recipeCategory: ["Dinner", "Main Course"],
        totalTime: "PT45M",
        nutrition: { calories: "600 calories" },
        recipeIngredient: ["chicken", "potatoes"],
      }),
    ],
    [
      unknownUrl,
      fetchedPage(unknownUrl, {
        name: "Spinach Omelette",
        totalTime: "PT15M",
        nutrition: { calories: "250 calories" },
        recipeIngredient: ["eggs", "spinach"],
      }),
    ],
  ]);

  const result = await recommendRecipes(
    { mealType: "breakfast", resultCount: 2 },
    {},
    {
      search: async () => ({
        results: [breakfastUrl, dinnerUrl, unknownUrl].map((link) => ({
          link,
        })),
      }),
      fetchPage: async (url) => pages.get(url),
    }
  );

  const titles = result.recipes.map(({ title }) => title);
  assert.ok(titles.includes("Blueberry Muffins"));
  assert.ok(!titles.includes("Chicken Dinner"));
  assert.ok(titles.includes("Spinach Omelette"));
  assert.equal(result.meta.applied.mealType, "breakfast");
});

test("recently shown recipes are excluded when new ones exist and reused with a penalty otherwise", async () => {
  const firstUrl = "https://seen.example/first";
  const secondUrl = "https://seen.example/second";
  const makePage = (url, name) =>
    fetchedPage(url, {
      name,
      totalTime: "PT20M",
      nutrition: { calories: "350 calories" },
      recipeIngredient: ["chicken", "rice"],
    });
  const searchAndFetch = {
    search: async () => ({
      results: [firstUrl, secondUrl].map((link) => ({ link })),
    }),
    fetchPage: async (url) => makePage(url, url.endsWith("first") ? "First Recipe" : "Second Recipe"),
  };

  const fresh = await recommendRecipes(
    { resultCount: 1 },
    { excludeRecipeUrls: [firstUrl] },
    searchAndFetch
  );
  assert.equal(fresh.recipes[0].title, "Second Recipe");
  assert.equal(fresh.meta.seenCandidatesExcluded, 1);
  assert.equal(fresh.meta.recentlyShownReused, 0);

  const reused = await recommendRecipes(
    { resultCount: 2 },
    { excludeRecipeUrls: [firstUrl, secondUrl] },
    searchAndFetch
  );
  assert.equal(reused.recipes.length, 2);
  assert.equal(reused.meta.recentlyShownReused, 2);
  assert.ok(
    reused.warnings.some(({ code }) => code === "RECENTLY_SHOWN_REUSED")
  );
});

test("widening searches continue until enough parseable candidates exist", async () => {
  const urls = Array.from(
    { length: 7 },
    (_, index) => `https://widen.example/r${index}`
  );
  const pages = new Map(
    urls.map((url, index) => [
      url,
      fetchedPage(url, {
        name: `Recipe ${index}`,
        totalTime: "PT20M",
        nutrition: { calories: "300 calories" },
        recipeIngredient: ["chicken", "rice"],
      }),
    ])
  );
  let searches = 0;
  const result = await recommendRecipes(
    { resultCount: 5 },
    {},
    {
      search: async () => {
        searches += 1;
        if (searches <= 2) return { results: urls.slice(0, 2).map((link) => ({ link })) };
        return { results: urls.slice(2).map((link) => ({ link })) };
      },
      fetchPage: async (url) => pages.get(url),
    }
  );

  assert.ok(searches >= 4);
  assert.ok(searches <= 8);
  assert.ok(result.meta.pagesFetched >= 7);
  assert.equal(result.meta.candidatesParsed, 7);
  assert.equal(result.recipes.length, 5);
});
