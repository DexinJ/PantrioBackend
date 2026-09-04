// src/chat/tools.js (updated)
// - Replaces listItemsAndUpdateTags with streamlineLists
// - Adds streamlineLists to TRIAL_ALLOWED_TOOLS
// - Updates tool description + schema to match your new behavior
// - Keeps the rest unchanged

import { SERPER_API_KEY } from "../config/env.js";
import {
  SafeWebFetchError,
  fetchPublicTextPage,
} from "./safeWebFetch.js";
import {
  FREE_MAX_RESULT_COUNT,
  recommendRecipes as runRecipeRecommendations,
} from "./recipeRecommendations.js";
import {
  estimateAndApplyRecipeMetadata,
  recipeEstimationEnabled,
} from "./recipeEstimation.js";

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
// ✅ CHANGED: add these helpers
function stripHtmlToText(html) {
  // very lightweight HTML → text (good enough to extract ingredients/steps)
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isProbablyRecipePage(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("ingredients") &&
    (t.includes("instructions") || t.includes("directions") || t.includes("method"))
  );
}
// ✅ END CHANGED

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

  return async function recommendRecipesTool(args, ctx) {
    return recommendRecipesFn(args, ctx?.recipeContext || {}, {
      search: search || TOOLS.webSearch,
      fetchPage,
      signal: ctx?.signal,
      estimateMeta,
      estimationEnabled,
      maxResultCount:
        ctx?.recipeMaxResultCount == null
          ? FREE_MAX_RESULT_COUNT
          : ctx.recipeMaxResultCount,
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

  // ✅ NEW: browse/fetch a URL and return readable text
  webFetch: async (args, ctx) => {
    const url = typeof args?.url === "string" ? args.url.trim() : "";
    const maxChars = Number.isFinite(args?.maxChars)
      ? Math.max(1000, Math.min(20000, args.maxChars))
      : 12000;

    if (!url) return { error: "Missing url", url: "", text: "" };

    try {
      const page = await fetchPublicTextPage(url, { signal: ctx?.signal });
      const fullText = stripHtmlToText(page.text);
      const clipped = fullText.slice(0, maxChars);

      return {
        url: page.url,
        text: clipped,
        clipped: page.truncated || fullText.length > clipped.length,
        isRecipeLikely: isProbablyRecipePage(clipped),
      };
    } catch (error) {
      return {
        code:
          error instanceof SafeWebFetchError
            ? error.code
            : "FETCH_FAILED",
        error:
          error instanceof SafeWebFetchError
            ? error.message
            : "The webpage could not be fetched.",
        url,
        text: "",
      };
    }
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
    "You MUST provide exactly 1 storage, exactly 1 urgency, and exactly 1 food_type category. state is optional.",
  properties: {
    storage: {
      type: "string",
      enum: PRESET_STORAGE_CATEGORIES,
      description: "REQUIRED. Exactly one storage category.",
    },
    urgency: {
      type: "string",
      enum: PRESET_URGENCY_CATEGORIES,
      description: "REQUIRED. Exactly one urgency category.",
    },
    food_type: {
      type: "string",
      enum: PRESET_FOOD_TYPE_CATEGORIES,
      description: "REQUIRED. Exactly one food type category.",
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
    "Whole-day shelf-life estimate from today (e.g. raw chicken 2, milk 7, frozen meat 180). Always express expiry this way; never pass calendar dates. The app converts this to an expiration date when the change is applied.",
};

export const RECOMMEND_RECIPES_TOOL = {
  type: "function",
  function: {
    name: "recommendRecipes",
    description:
      "Find and rank real recipes using the user's trusted fridge inventory and saved recipe preferences. Use this for recipe ideas, meal ideas, or 'what can I cook?' requests. Call it once per user request. A follow-up after a previous recipe answer is a NEW request: pass only constraints from the latest user message. Recipes shown recently are re-admitted with low priority only when few new options exist. Put only constraints stated for the current request in the arguments; saved defaults and fridge items are supplied separately by the app.",
    parameters: {
      type: "object",
      properties: {
        preferredCuisines: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description:
            "Cuisines requested for this meal, such as Asian, Japanese, Mexican, or American.",
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
          description:
            "Explicit calorie ceiling per serving, or null when none was stated.",
        },
        maxPrepMinutes: {
          type: ["integer", "null"],
          minimum: 5,
          maximum: 480,
          description:
            "Explicit total-time ceiling in minutes, or null when none was stated.",
        },
        mealType: {
          type: ["string", "null"],
          enum: ["breakfast", "lunch", "dinner", "snack", "dessert"],
          description: "Requested meal type for this meal.",
        },
        skillLevel: {
          type: ["string", "null"],
          enum: ["beginner", "intermediate", "advanced"],
          description:
            "Cooking skill level requested. Only pass it when the user states a skill or difficulty; never invent one.",
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
            "Cooking method the user asked for (e.g. air fryer, Instant Pot, one pot, sheet pan). Only pass it when the user states a method; never invent one.",
        },
        maxIngredients: {
          type: ["integer", "null"],
          minimum: 3,
          maximum: 30,
          description:
            "Maximum number of ingredients the user is willing to use. Only pass it when the user states a count.",
        },
        dietaryPatterns: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
          description:
            "Dietary constraints stated for this meal, such as vegetarian or gluten-free.",
        },
        mustUseIngredients: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description:
            "Ingredients the user explicitly asked to use. Do not copy the full fridge inventory here.",
        },
        excludedIngredients: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description:
            "Ingredients the user explicitly asked to avoid for this meal.",
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
          maximum: 10,
          description:
            "Number of recipe suggestions requested (1-10, entitlement-gated). Default is 5.",
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
      "Show a confirmation card for saving persistent recipe preferences. Use when the user asks to remember/save/always/usually prefer something, or clearly states a durable allergy or dietary pattern. This tool does not save by itself. Never use it for a one-meal constraint such as 'no peanuts tonight'.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["merge", "remove", "replace"],
          description:
            "Use merge to add preferences (default), remove to delete named list values, and replace only when the user explicitly asks to replace or clear a field.",
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

// OpenAI tool schema
export const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "webSearch",
      description:
        "Search the web only when the user explicitly asks to browse/search online or when an answer requires up-to-date external facts such as news, prices, or recalls. Do not use for recipe recommendations; use recommendRecipes instead. Do not use for normal fridge or shopping-list actions.",
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
        "Add an item to the fridge (mutates state). You MUST include categories with exactly 1 storage, exactly 1 urgency, and exactly 1 food_type. state is optional. Estimate shelf life in whole days with expiresInDays based on food_type, storage, and state. Never invent categories.",
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
        "Add an item to the shopping list (mutates state). You MUST include categories with exactly 1 storage, exactly 1 urgency, and exactly 1 food_type. state is optional. Never invent categories.",
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

  {
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
  },

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
        "UI-only (no state changes): after the user attaches a fridge image, or explicitly asks to add a clearly listed batch, show one 'Add all to fridge' confirmation card for the extracted items. Never use this for recipe ingredients, recipe results, meal ideas, or ordinary bullet lists. Each item MUST include categories with exactly 1 storage, exactly 1 urgency, and exactly 1 food_type; state is optional. Estimate shelf life in whole days with expiresInDays based on food_type, storage, and state. Never invent categories.",
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
        "Streamline the fridge and/or shopping lists. This tool may mutate state by normalizing item name/quantity and ensuring items have a food_type tag. MANDATORY TAGGING: if an item has NO tags, you MUST infer and APPLY a preset food_type tag when possible. If retag=true, you may also correct an incorrect/missing food_type tag. NEVER invent new tags outside presets. NEVER remove or modify storage/urgency/state tags.",
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
              "If true, also correct existing food_type tags when the inference differs. If false, only add food_type when tags are missing.",
            default: true,
          },
          dryRun: {
            type: "boolean",
            description:
              "If true, do not apply edits; only return what would change. NOTE: if there are tagless items, you should run with dryRun=false to actually fix them.",
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
        "Edit a single fridge item: rename it, change its quantity, categories, or expiry (expiry is a whole-day estimate in expiresInDays). Resolve the item by id when available, otherwise by exact name. For changes to several items, use proposeBulkFridgeUpdate instead.",
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
        "Show one confirmation card for multiple fridge changes (rename, quantity, categories, expiry in whole-day expiresInDays, or removal). Resolve each entry by id when available, otherwise by exact name. Nothing is changed until the user confirms on the card.",
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
        "After recommendRecipes returns, propose adding the recommended recipes' missing ingredients to the shopping list. Shows one confirmation card; nothing is added until the user confirms. Never use for the fridge and never call before recommendRecipes.",
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
