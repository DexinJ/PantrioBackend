// src/chat/tools.js (updated)
// - Replaces listItemsAndUpdateTags with streamlineLists
// - Adds streamlineLists to TRIAL_ALLOWED_TOOLS
// - Updates tool description + schema to match your new behavior
// - Keeps the rest unchanged

import { SERPER_API_KEY } from "../config/env.js";
import { fetchPublicTextPage } from "./safeWebFetch.js";
import {
  FREE_MAX_RESULT_COUNT,
  recommendRecipes as runRecipeRecommendations,
} from "./recipeRecommendations.js";
import {
  recipeTranslationEnabled,
  searchRecipesWithDish,
  translateRecipes,
} from "./recipeDishSearch.js";
import { withMissingItems } from "./recipeMissingItems.js";
import {
  estimateAndApplyRecipeMetadata,
  recipeEstimationEnabled,
} from "./recipeEstimation.js";
import {
  generateRecipeIdeas as runRecipeIdeation,
  recipeIdeationEnabled,
} from "./recipeIdeation.js";

// ✅ Single source of truth for what GPT is allowed to send
export const PRESET_CATEGORIES = [
  // storage
  "Fridge",
  "Freezer",
  "Pantry",

  // urgency
  "Expired",
  "Eat first",
  "Use soon",
  "Lasts a while",
  "Long keeper",

  // food types
  "Produce",
  "Dairy",
  "Meat",
  "Seafood",
  "Prepared",
  "Condiments",
  "Beverages",
  "Snacks",
  "Bakery",
  "Frozen",

  // state
  "Opened",
  "Unopened",
  "Raw",
  "Cooked",
  "Cut",
  "Whole",
];

// ✅ Enums split by type so we can enforce "one storage + one urgency"
export const PRESET_STORAGE_CATEGORIES = ["Fridge", "Freezer", "Pantry"];
export const PRESET_URGENCY_CATEGORIES = [
  "Expired",
  "Eat first",
  "Use soon",
  "Lasts a while",
  "Long keeper",
];

// (optional) other buckets, still allowed as extras
export const PRESET_FOOD_TYPE_CATEGORIES = [
  "Produce",
  "Dairy",
  "Meat",
  "Seafood",
  "Prepared",
  "Condiments",
  "Beverages",
  "Snacks",
  "Bakery",
  "Frozen",
];
export const PRESET_STATE_CATEGORIES = ["Opened", "Unopened", "Raw", "Cooked", "Cut", "Whole"];

async function fetchWithDeadline(url, options, { signal, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("Request timed out.")),
    timeoutMs
  );
  timeout.unref?.();

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export function createRecommendRecipesTool({
  recommendRecipesFn = runRecipeRecommendations,
  search,
  fetchPage = fetchPublicTextPage,
  estimateMeta = estimateAndApplyRecipeMetadata,
  estimationEnabled = recipeEstimationEnabled(),
  ideate = runRecipeIdeation,
  ideationEnabled = recipeIdeationEnabled(),
} = {}) {
  if (typeof recommendRecipesFn !== "function") {
    throw new TypeError("recommendRecipesFn must be a function");
  }
  if (search !== undefined && typeof search !== "function") {
    throw new TypeError("search must be a function when provided");
  }
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchPage must be a function");
  }
  if (typeof estimateMeta !== "function") {
    throw new TypeError("estimateMeta must be a function");
  }
  if (typeof ideate !== "function") {
    throw new TypeError("ideate must be a function");
  }

  return async function recommendRecipesTool(args, ctx) {
    const recipeContext = ctx?.recipeContext || {};
    const dependencies = {
      search: search || TOOLS.webSearch,
      fetchPage,
      signal: ctx?.signal,
      estimateMeta,
      estimationEnabled,
      ideate,
      ideationEnabled,
      language: recipeContext?.language,
      translate: translateRecipes,
      translationEnabled: recipeTranslationEnabled(),
      maxResultCount:
        ctx?.recipeMaxResultCount == null
          ? FREE_MAX_RESULT_COUNT
          : ctx.recipeMaxResultCount,
    };
    // A named dish goes through the dish pipeline; everything else keeps using
    // the inventory engine unchanged.
    const result =
      typeof args?.dishQuery === "string" && args.dishQuery.trim()
        ? await searchRecipesWithDish(args, recipeContext, dependencies)
        : await recommendRecipesFn(args, recipeContext, dependencies);
    // The card ships addable items alongside the publisher's lines, so the
    // shopping-list button needs no parser and no model round trip.
    return withMissingItems(result, {
      language: recipeContext.language,
      signal: ctx?.signal,
    });
  };
}

export const TOOLS = {
  /**
   * Web search via Serper.dev
   * Returns: { query, results: [{ title, link, snippet }] }
   */
  webSearch: async (args, ctx) => {
    const q = typeof args?.query === "string" ? args.query.trim() : "";
    const k = Number.isFinite(args?.k) ? Math.max(1, Math.min(10, args.k)) : 5;

    if (!q) return { query: q, results: [] };

    if (!SERPER_API_KEY) {
      return { error: "Missing SERPER_API_KEY on server", query: q, results: [] };
    }

    let resp;
    try {
      resp = await fetchWithDeadline(
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q, num: k }),
        },
        { signal: ctx?.signal }
      );
    } catch {
      return {
        error: "Web search is temporarily unavailable.",
        query: q,
        results: [],
      };
    }

    if (!resp.ok) {
      return {
        error: `Serper error ${resp.status}`,
        query: q,
        results: [],
      };
    }

    const data = await resp.json().catch(() => ({}));
    const organic = Array.isArray(data?.organic) ? data.organic : [];

    const results = organic.slice(0, k).map((r) => ({
      title: r?.title || "",
      link: r?.link || "",
      snippet: r?.snippet || "",
    }));

    return { query: q, results };
  },

  recommendRecipes: createRecommendRecipesTool(),
};


// ✅ Schema snippet reused across tools:
// Require:
// - storage: exactly 1
// - urgency: exactly 1
// - food_type: exactly 1
// Allow optional extras:
// - state: 0-1
const CATEGORY_SCHEMA = {
  type: "object",
  description:
    "Exactly 1 storage, exactly 1 urgency, exactly 1 food_type. state is optional.",
  properties: {
    storage: {
      type: "string",
      enum: PRESET_STORAGE_CATEGORIES,
      description: "Exactly one storage category.",
    },
    urgency: {
      type: "string",
      enum: PRESET_URGENCY_CATEGORIES,
      description: "Exactly one urgency category.",
    },
    food_type: {
      type: "string",
      enum: PRESET_FOOD_TYPE_CATEGORIES,
      description: "Exactly one food type category.",
    },
    state: {
      type: "string",
      enum: PRESET_STATE_CATEGORIES,
      description: "Optional state category.",
    },
  },
  required: ["storage", "urgency", "food_type"],
  additionalProperties: false,
};

const EXPIRES_IN_DAYS_SCHEMA = {
  type: "integer",
  minimum: 1,
  description:
    "Whole-day shelf-life estimate from today (e.g. raw chicken 2, milk 7, frozen meat 180). Never pass calendar dates.",
};

export const RECOMMEND_RECIPES_TOOL = {
  type: "function",
  function: {
    name: "recommendRecipes",
    description:
      "Find and rank real recipes from the user's fridge inventory and saved preferences. Search fresh each request; never skip a recipe shown before. Use for recipe/meal/'what can I cook?' requests. Call once per request. A follow-up is a new request: pass only the latest message's constraints. If the user names an ingredient (or selects one fridge item), return only recipes containing it. The app supplies saved defaults and fridge items; pass only current-meal constraints.",
    parameters: {
      type: "object",
      properties: {
        dishQuery: {
          type: ["string", "null"],
          description:
            "The dish the user named, exactly as they said it in their language (e.g. 'tomato egg stir fry', '番茄炒蛋'). Set when the user names a dish. Never translate or copy into mustUseIngredients. Null when the user listed ingredients instead.",
        },
        preferredCuisines: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: "Cuisines requested for this meal (e.g. Asian, Mexican).",
        },
        energyPreference: {
          type: "string",
          enum: ["any", "light", "balanced", "hearty"],
          description: "How light or filling this meal should be.",
        },
        maxCaloriesPerServing: {
          type: ["integer", "null"],
          minimum: 100,
          maximum: 2500,
          description: "Calorie ceiling per serving, or null if none stated.",
        },
        maxPrepMinutes: {
          type: ["integer", "null"],
          minimum: 5,
          maximum: 480,
          description: "Total-time ceiling in minutes, or null if none stated.",
        },
        mealType: {
          type: ["string", "null"],
          enum: ["breakfast", "lunch", "dinner", "snack", "dessert"],
          description: "Requested meal type for this meal.",
        },
        skillLevel: {
          type: ["string", "null"],
          enum: ["beginner", "intermediate", "advanced"],
          description: "Cooking skill level. Only pass when the user states one.",
        },
        cookingMethod: {
          type: ["string", "null"],
          enum: [
            "air_fryer",
            "instant_pot",
            "one_pot",
            "sheet_pan",
            "grill",
            "stovetop",
            "oven",
          ],
          description:
            "Cooking method the user asked for (e.g. air fryer, one pot). Only pass when stated.",
        },
        maxIngredients: {
          type: ["integer", "null"],
          minimum: 3,
          maximum: 30,
          description: "Max ingredients the user is willing to use. Only pass when stated.",
        },
        dietaryPatterns: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
          description: "Dietary constraints for this meal (e.g. vegetarian, gluten-free).",
        },
        mustUseIngredients: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "Ingredients the user explicitly asked to use. Never copy the full fridge inventory.",
        },
        excludedIngredients: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "Ingredients to avoid for this meal.",
        },
        servings: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "Requested serving count.",
        },
        resultCount: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Number of recipe suggestions (1-4; default 4).",
        },
      },
      additionalProperties: false,
    },
  },
};

export const PROPOSE_RECIPE_PREFERENCE_UPDATE_TOOL = {
  type: "function",
  function: {
    name: "proposeRecipePreferenceUpdate",
    description:
      "Show a confirmation card to save persistent recipe preferences (remember/save/always/usually, or a durable allergy/diet). Does not save by itself. Never use for a one-meal constraint like 'no peanuts tonight'.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["merge", "remove", "replace"],
          description: "merge adds (default), remove deletes named values, replace clears/replaces a field.",
        },
        patch: {
          type: "object",
          properties: {
            preferredCuisines: { type: "array", items: { type: "string" }, maxItems: 20 },
            dislikedCuisines: { type: "array", items: { type: "string" }, maxItems: 20 },
            allergens: { type: "array", items: { type: "string" }, maxItems: 20 },
            dietaryPatterns: { type: "array", items: { type: "string" }, maxItems: 20 },
            excludedIngredients: { type: "array", items: { type: "string" }, maxItems: 30 },
            dislikedIngredients: { type: "array", items: { type: "string" }, maxItems: 30 },
            preferredEnergy: {
              type: "string",
              enum: ["any", "light", "balanced", "hearty"],
            },
            maxCaloriesPerServing: { type: ["integer", "null"], minimum: 100, maximum: 2500 },
            maxPrepMinutes: { type: ["integer", "null"], minimum: 5, maximum: 480 },
            defaultServings: { type: "integer", minimum: 1, maximum: 12 },
          },
          additionalProperties: false,
        },
        summary: {
          type: "string",
          maxLength: 160,
          description: "Short user-facing summary of what will be saved.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
};

// Read-only fridge reader. Exported so recipe mode can offer it alongside the
// recommendation tool: the model checks what the user actually has before it
// searches, instead of the app inlining the inventory into the prompt.
export const GET_FRIDGE_CONTENTS_TOOL = {
  type: "function",
  function: {
    name: "getFridgeContents",
    description: "Read-only: get all fridge items.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

// OpenAI tool schema
export const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "webSearch",
      description:
        "Search the web only when the user asks to browse/search online or the answer needs up-to-date facts (news, prices, recalls). Never use for recipes (use recommendRecipes) or for fridge/shopping-list actions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          k: {
            type: "integer",
            description: "Number of results (1-10).",
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  RECOMMEND_RECIPES_TOOL,
  PROPOSE_RECIPE_PREFERENCE_UPDATE_TOOL,
// src/chat/tools.js (OPENAI_TOOLS array)
  // {
  //   type: "function",
  //   function: {
  //     name: "webFetch",
  //     description:
  //       "Fetch a webpage URL and return readable text content for summarizing/extracting recipe ingredients/instructions. Use after webSearch. Only fetch URLs from webSearch results.",
  //     parameters: {
  //       type: "object",
  //       properties: {
  //         url: { type: "string", description: "The URL to fetch (must be http/https)." },
  //         maxChars: {
  //           type: "integer",
  //           description: "Max characters of text to return (1000-20000). Default 12000.",
  //           minimum: 1000,
  //           maximum: 20000,
  //         },
  //       },
  //       required: ["url"],
  //       additionalProperties: false,
  //     },
  //   },
  // },

  {
    type: "function",
    function: {
      name: "addFridgeItem",
      description:
        "Add an item to the fridge. Include exactly 1 storage, 1 urgency, 1 food_type (state optional). Estimate shelf life in whole days with expiresInDays. Never invent categories.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Item name (e.g., 'milk')." },
          quantity: {
            type: "string",
            description: "Amount/size (e.g., '2 cartons', '1L'). Default '1'.",
          },
          categories: CATEGORY_SCHEMA,
          expiresInDays: EXPIRES_IN_DAYS_SCHEMA,
        },
        required: ["name", "categories"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "addShoppingItem",
      description:
        "Add an item to the shopping list. Include exactly 1 storage, 1 urgency, 1 food_type (state optional). Never invent categories.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Item name (e.g., 'eggs')." },
          quantity: {
            type: "string",
            description: "Amount (e.g., 'dozen'). Default '1'.",
          },
          categories: CATEGORY_SCHEMA,
        },
        required: ["name", "categories"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "removeFridgeItem",
      description:
        "Remove an item from the fridge by name (mutates state). If ambiguous, ask one clarifying question first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the item to remove." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "removeShoppingItem",
      description:
        "Remove an item from the shopping list by name (mutates state). If ambiguous, ask one clarifying question first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the item to remove." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "findInFridge",
      description: "Read-only: check if an item exists in the fridge. Do NOT modify state.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the item to check." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "findInShoppingList",
      description: "Read-only: check if an item exists in the shopping list. Do NOT modify state.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name of the item to check." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },

  GET_FRIDGE_CONTENTS_TOOL,

  {
    type: "function",
    function: {
      name: "getShoppingListContents",
      description: "Read-only: get all shopping list items.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "proposeAddAllToFridge",
      description:
        "UI-only: after a fridge image or an explicit batch-add request, show one 'Add all to fridge' confirmation card. Never use for recipes, meal ideas, or ordinary lists. Each item needs exactly 1 storage, 1 urgency, 1 food_type (state optional) and a whole-day expiresInDays estimate. Never invent categories.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "List of extracted items to propose adding.",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Item name." },
                quantity: { type: "string", description: "Optional amount/size." },
                categories: CATEGORY_SCHEMA,
                expiresInDays: EXPIRES_IN_DAYS_SCHEMA,
              },
              required: ["name", "categories"],
              additionalProperties: false,
            },
          },
          title: { type: "string", description: "Optional button title." },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },

  // ✅ NEW: streamlineLists (replaces listItemsAndUpdateTags)
  {
    type: "function",
    function: {
      name: "streamlineLists",
      description:
        "Normalize fridge/shopping items (name/quantity) and ensure food_type tags. If an item has no tags, infer and apply a preset food_type. If retag=true, also correct wrong/missing food_type. Never invent tags outside presets, and never touch storage/urgency/state tags.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["shopping", "fridge", "both"],
            description: "Which list(s) to streamline.",
          },
          retag: {
            type: "boolean",
            description:
              "Also correct existing food_type tags when they differ; if false, only fill missing tags.",
            default: true,
          },
          dryRun: {
            type: "boolean",
            description:
              "Preview only; do not apply. To actually fix tagless items, run with dryRun=false.",
            default: false,
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
  },

  // Client-owned: forwarded to the app, which executes them and returns the
  // result. Schemas live here so the model can propose them.
  {
    type: "function",
    function: {
      name: "updateFridgeItem",
      description:
        "Edit one fridge item (name, quantity, categories, or whole-day expiresInDays). Resolve by id when available, otherwise by exact name. For several items use proposeBulkFridgeUpdate.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Fridge item id, when known." },
          name: { type: "string", description: "Exact item name, when id is unknown." },
          updates: {
            type: "object",
            properties: {
              name: { type: "string", description: "New item name." },
              quantity: { type: "string", description: "New amount/size." },
              categories: CATEGORY_SCHEMA,
              expiresInDays: EXPIRES_IN_DAYS_SCHEMA,
            },
            additionalProperties: false,
          },
        },
        required: ["updates"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "proposeBulkFridgeUpdate",
      description:
        "Show one confirmation card for multiple fridge changes (rename, quantity, categories, whole-day expiresInDays, or remove). Resolve by id when available, otherwise by exact name. Nothing changes until confirmed.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Fridge item id, when known." },
                name: { type: "string", description: "Exact item name, when id is unknown." },
                update: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    quantity: { type: "string" },
                    categories: CATEGORY_SCHEMA,
                    expiresInDays: EXPIRES_IN_DAYS_SCHEMA,
                  },
                  additionalProperties: false,
                },
                remove: {
                  type: "boolean",
                  description: "Set true to remove this item from the fridge.",
                },
              },
              additionalProperties: false,
            },
          },
          title: { type: "string", description: "Optional card title." },
        },
        required: ["changes"],
        additionalProperties: false,
      },
    },
  },

  {
    type: "function",
    function: {
      name: "proposeAddMissingIngredientsToShoppingList",
      description:
        "After recommendRecipes, propose adding missing ingredients to the shopping list. One confirmation card; nothing is added until confirmed. Never use for the fridge or before recommendRecipes.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Ingredient name." },
                quantity: { type: "string", description: "Optional amount." },
                categories: CATEGORY_SCHEMA,
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          title: { type: "string", description: "Optional card title." },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
];

export const PROPOSE_ADD_MISSING_INGREDIENTS_TO_SHOPPING_LIST_TOOL =
  OPENAI_TOOLS.find(
    (tool) =>
      tool?.function?.name === "proposeAddMissingIngredientsToShoppingList"
  );
