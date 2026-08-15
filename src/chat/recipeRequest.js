import {
  OPENAI_TOOLS,
  RECOMMEND_RECIPES_TOOL,
} from "./tools.js";

const RECIPE_INTENT = "recipe_recommendation";
const MAX_INVENTORY_ITEMS = 100;
const MAX_SELECTED_INGREDIENTS = 30;

function cleanString(value, maxLength = 120) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function cleanStringArray(value, maxItems = 30) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(value) ? value.slice(0, maxItems * 4) : []) {
    const cleaned = cleanString(entry, 80);
    const key = cleaned.toLocaleLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanNullableInteger(value, min, max) {
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function cleanScoreMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  let inspected = 0;
  for (const rawKey in value) {
    if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
    inspected += 1;
    if (inspected > 200 || Object.keys(output).length >= 50) break;
    const rawScore = value[rawKey];
    const key = cleanString(rawKey, 80);
    const score = Number(rawScore);
    if (!key || !Number.isFinite(score)) continue;
    output[key] = Math.min(10, Math.max(-10, score));
  }
  return output;
}

export function normalizeChatIntent(value) {
  return value === RECIPE_INTENT ? RECIPE_INTENT : "chat";
}

export function sanitizeRecipeContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const rawPreferences = source.preferences && typeof source.preferences === "object"
    ? source.preferences
    : {};
  const rawExplicit = rawPreferences.explicit && typeof rawPreferences.explicit === "object"
    ? rawPreferences.explicit
    : {};
  const rawLearned = rawPreferences.learned && typeof rawPreferences.learned === "object"
    ? rawPreferences.learned
    : {};
  const energy = ["any", "light", "balanced", "hearty"].includes(
    rawExplicit.preferredEnergy
  )
    ? rawExplicit.preferredEnergy
    : "any";

  return {
    inventory: (Array.isArray(source.inventory) ? source.inventory : [])
      .slice(0, MAX_INVENTORY_ITEMS)
      .map((item) => ({
        name: cleanString(item?.name, 120),
        quantity: cleanString(item?.quantity, 80),
      }))
      .filter(({ name }) => name),
    selectedIngredients: cleanStringArray(
      source.selectedIngredients,
      MAX_SELECTED_INGREDIENTS
    ),
    preferences: {
      schemaVersion: 1,
      explicit: {
        preferredCuisines: cleanStringArray(rawExplicit.preferredCuisines, 20),
        dislikedCuisines: cleanStringArray(rawExplicit.dislikedCuisines, 20),
        allergens: cleanStringArray(rawExplicit.allergens, 20),
        dietaryPatterns: cleanStringArray(rawExplicit.dietaryPatterns, 20),
        excludedIngredients: cleanStringArray(rawExplicit.excludedIngredients, 30),
        dislikedIngredients: cleanStringArray(rawExplicit.dislikedIngredients, 30),
        preferredEnergy: energy,
        maxCaloriesPerServing: cleanNullableInteger(
          rawExplicit.maxCaloriesPerServing,
          100,
          2500
        ),
        maxPrepMinutes: cleanNullableInteger(rawExplicit.maxPrepMinutes, 5, 480),
        defaultServings: cleanNullableInteger(rawExplicit.defaultServings, 1, 12) || 2,
      },
      learned: {
        cuisineScores: cleanScoreMap(rawLearned.cuisineScores),
        ingredientScores: cleanScoreMap(rawLearned.ingredientScores),
      },
      personalization: {
        enabled: rawPreferences.personalization?.enabled !== false,
        learnFromActivity:
          rawPreferences.personalization?.learnFromActivity === true,
      },
    },
  };
}

export function resolveRoundToolPolicy({ intent, round = 0 } = {}) {
  if (normalizeChatIntent(intent) !== RECIPE_INTENT) {
    return {
      tools: OPENAI_TOOLS,
      toolChoice: "auto",
      parallelToolCalls: false,
    };
  }

  if (round === 0) {
    return {
      tools: [RECOMMEND_RECIPES_TOOL],
      toolChoice: {
        type: "function",
        function: { name: "recommendRecipes" },
      },
      parallelToolCalls: false,
    };
  }

  return {
    tools: [],
    toolChoice: undefined,
    parallelToolCalls: undefined,
  };
}
