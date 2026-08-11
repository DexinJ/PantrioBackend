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

// ✅ Single source of truth for what GPT is allowed to send
export const PRESET_CATEGORIES = [
  // storage
  "Fridge",
  "Freezer",
  "Pantry",

  // urgency
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
export const PRESET_URGENCY_CATEGORIES = ["Eat first", "Use soon", "Lasts a while", "Long keeper"];

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
  "Other",
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

const EXPIRES_AT_SCHEMA = {
  type: "string",
  description:
    "REQUIRED. Expiration date/time for this item. Prefer ISO date 'YYYY-MM-DD' (e.g., '2026-02-01'). If user gives relative time like 'in 5 days', convert to an ISO date string.",
};

// OpenAI tool schema
export const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "webSearch",
      description:
        "Search the web when the user asks for recipes (e.g., recipe ideas, what can I cook, meal ideas) OR explicitly asks to browse/search online OR when answering requires up-to-date external facts (news, prices, recalls). Do NOT use for normal fridge/shopping actions. When used for recipes, return real recipe links from well-known cooking sites.",
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
        "Add an item to the fridge (mutates state). You MUST include categories with exactly 1 storage, exactly 1 urgency, and exactly 1 food_type. state is optional. Predict an expiration date based on food_type and storage and include expiresAt (YYYY-MM-DD). Never invent categories.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Item name (e.g., 'milk')." },
          quantity: {
            type: "string",
            description: "Amount/size (e.g., '2 cartons', '1L'). Default '1'.",
          },
          categories: CATEGORY_SCHEMA,
          expiresAt: EXPIRES_AT_SCHEMA,
        },
        required: ["name", "categories", "expiresAt"],
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
        "UI-only (no state changes): propose an 'Add all to fridge' button/card with extracted items. Each item MUST include categories with exactly 1 storage, exactly 1 urgency, exactly 1 food_type, and exactly 1 expiresAt (YYYY-MM-DD). state is optional. Predict the expiration date for each item based on food_type and storage. Never invent categories.",
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
                expiresAt: EXPIRES_AT_SCHEMA,
              },
              required: ["name", "categories", "expiresAt"],
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
];
