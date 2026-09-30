import {
  GET_FRIDGE_CONTENTS_TOOL,
  OPENAI_TOOLS,
  RECOMMEND_RECIPES_TOOL,
} from "./tools.js";
import { RECOMMEND_RECIPES_TOOL_NAME } from "./toolNames.js";

const RECIPE_INTENT = "recipe_recommendation";
const MAX_INVENTORY_ITEMS = 100;
const MAX_SELECTED_INGREDIENTS = 30;

// Explicit UI commands. These are decisions the user made by tapping a button,
// not text the classifier guessed at, so they may force the recipe pipeline.
export const RECIPE_UI_ACTIONS = Object.freeze(["findRecipes"]);

const RECIPE_UI_ACTION = "findRecipes";

// A bare meal word is only a recipe request when the assistant just showed
// recipe cards. Alone ("breakfast") it is ambiguous, and "菜系"/"香菜" must
// never be read as "菜".
const MEAL_WORDS = {
  en: ["breakfast", "brunch", "lunch", "dinner", "supper", "snack", "dessert"],
  zh: ["早餐", "早饭", "午饭", "午餐", "中餐", "晚饭", "晚餐", "甜点", "点心", "零食", "宵夜"],
};

const MEAL_FILLER_TOKENS = new Set([
  "make",
  "me",
  "give",
  "some",
  "more",
  "a",
  "an",
  "any",
  "another",
  "idea",
  "ideas",
  "suggestion",
  "suggestions",
  "option",
  "options",
  "for",
  "please",
  "instead",
  "now",
  "tonight",
]);

const MEAL_FILLER_PREFIXES_ZH = [
  "来点",
  "来个",
  "来一个",
  "再来点",
  "再来个",
  "再来一个",
  "再推荐",
  "再换",
  "换个",
  "换点",
  "换成",
  "更多",
  "给我",
  "推荐",
  "想吃",
  "想要",
  "做点",
  "弄点",
  "换一个",
  "换点",
];

const MEAL_FILLER_SUFFIXES_ZH = ["食谱", "推荐", "做法", "一下", "点", "的", "吧", "呢", "吗"];

// High-precision recipe asks. Deliberately excludes open-ended "what should I
// eat" phrasings: those are ambiguous and the model asks one clarifying
// question instead (see the Recipes rules in the system message).
const RECIPE_ASK_PATTERNS = [
  /\brecipes?\b/i,
  /\bmeal ideas?\b/i,
  /\bdish ideas?\b/i,
  /\bhow (?:do|can|should) i (?:cook|make|prepare)\b/i,
  /\bhow to (?:cook|make|prepare)\b/i,
  /\bwhat (?:can|should) i (?:cook|make)\b/i,
  /\bsomething (?:light|healthy|quick|hearty)(?: to eat| for (?:dinner|lunch|breakfast|supper))?\b/i,
  /\b(?:find|recommend|suggest|search for|look up)\b[^.!?]{0,40}\b(?:recipe|recipes|dish|dishes|meal|meals)\b/i,
  /\b(?:breakfast|lunch|dinner|brunch|supper|snack|dessert) ideas?\b/i,
  /\b(?:under|below|less than) \d{2,4} calories\b/i,
  /\blow[- ]calorie\b/i,
];

const RECIPE_ASK_TERMS_ZH = ["菜谱", "食谱", "做法", "怎么做", "怎么吃", "烹饪", "烹调"];

// Preference and settings statements are never recipe requests: they must
// reach proposeRecipePreferenceUpdate, which the recipe policy never offers.
const PREFERENCE_PATTERNS = [
  /\b(?:set|save|remember|add|update|change|clear)\b[^.!?]{0,24}\b(?:preference|preferences|cuisine|cuisines|diet|dietary|allerg\w*|dislik\w*)\b/i,
  /\b(?:preference|preferences|cuisine|cuisines|diet|dietary|allerg\w*)\b[^.!?]{0,24}\b(?:set|save|remember|add|update|change|clear)\b/i,
  /\b(?:always|usually)\b[^.!?]{0,24}\b(?:prefer|like|want|cook|eat)\b/i,
  /\ballergic to\b/i,
  /\b(?:i|we)\s+(?:really\s+)?(?:don'?t|do not|dont)\s+like\b/i,
];

const PREFERENCE_PATTERNS_ZH = [
  /(?:设置|设为|保存|记住|添加|修改|改成|更新|删除).{0,16}(?:偏好|菜系|口味|饮食|忌口|过敏)/,
  /(?:偏好|忌口|过敏|饮食|菜系|口味).{0,8}(?:设置|保存|记住|添加|修改|删除)/,
  /(?:我|咱)?(?:不喜欢|不爱吃|讨厌|爱吃|就爱)/,
  /过敏/,
];

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

export function normalizeRecipeUiAction(value) {
  const action = cleanString(value, 40);
  return RECIPE_UI_ACTIONS.includes(action) ? action : "";
}

/** True for settings/preference statements, which never force a recipe search. */
export function isPreferenceRequest(text) {
  const message = String(text || "").trim();
  if (!message) return false;
  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(message))) return true;
  return PREFERENCE_PATTERNS_ZH.some((pattern) => pattern.test(message));
}

/** True only for unambiguous "give me a recipe" phrasings. */
export function isExplicitRecipeAsk(text) {
  const message = String(text || "").trim();
  if (!message) return false;
  if (RECIPE_ASK_TERMS_ZH.some((term) => message.includes(term))) return true;
  return RECIPE_ASK_PATTERNS.some((pattern) => pattern.test(message));
}

function mealWordOf(text, language) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return "";
  const isChinese = String(language || "").toLowerCase().startsWith("zh");
  if (isChinese) {
    let stripped = raw.replace(/[\s!?！？,，。.]/g, "");
    for (const prefix of MEAL_FILLER_PREFIXES_ZH) {
      if (stripped.startsWith(prefix)) {
        stripped = stripped.slice(prefix.length);
        break;
      }
    }
    for (const suffix of MEAL_FILLER_SUFFIXES_ZH) {
      if (stripped.length > suffix.length && stripped.endsWith(suffix)) {
        stripped = stripped.slice(0, -suffix.length);
        break;
      }
    }
    return MEAL_WORDS.zh.find((term) => stripped === term) || "";
  }
  const tokens = raw
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !MEAL_FILLER_TOKENS.has(token));
  return tokens.length === 1 && MEAL_WORDS.en.includes(tokens[0]) ? tokens[0] : "";
}

/** True when the assistant's previous turn presented recipe cards. */
export function historyHasRecipeAnswer(history = []) {
  const entries = Array.isArray(history) ? history : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index];
    if (!message || typeof message !== "object") continue;
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || "").join(" ")
        : String(message.text || "");
    if (message.type === "recipe_cards") return true;
    if (/(?:recipes?|recipe ideas?|菜谱|食谱)/i.test(text)) return true;
    return false;
  }
  return false;
}

/**
 * A bare meal word ("breakfast", "来点早餐") only counts as a new recipe
 * request when the previous answer showed recipe cards; otherwise the model
 * decides with the full tool set.
 */
export function isRecipeFollowUp({ text = "", history = [], language = "en" } = {}) {
  if (!mealWordOf(text, language)) return false;
  return historyHasRecipeAnswer(history);
}

/**
 * Single routing decision for a chat request. The client's own classifier is
 * gone; free text is routed by these high-precision rules and otherwise left
 * to the model, which still has recommendRecipes available. The server flips
 * itself into recipe mode after the model actually calls the tool.
 */
export function resolveRequestRouting({
  text = "",
  history = [],
  uiAction = "",
  legacyIntent = "",
  selectedIngredients = [],
  language = "en",
} = {}) {
  return resolveRequestRoutingWithReason({
    text,
    history,
    uiAction,
    legacyIntent,
    selectedIngredients,
    language,
  }).intent;
}

/**
 * Same decision as `resolveRequestRouting`, plus why it was made. The reason is
 * logged (LOG_AI_REQUESTS) so a misroute can be traced to the rule that caused
 * it instead of being argued about from the model's narration.
 */
export function resolveRequestRoutingWithReason({
  text = "",
  history = [],
  uiAction = "",
  legacyIntent = "",
  selectedIngredients = [],
  language = "en",
} = {}) {
  if (normalizeRecipeUiAction(uiAction)) {
    return { intent: RECIPE_INTENT, reason: "uiAction" };
  }
  const message = String(text || "").trim();
  if (!message) return { intent: "chat", reason: "empty" };
  if (isPreferenceRequest(message)) {
    return { intent: "chat", reason: "preference" };
  }
  if (isExplicitRecipeAsk(message)) {
    return { intent: RECIPE_INTENT, reason: "explicitAsk" };
  }
  if (isRecipeFollowUp({ text: message, history, language })) {
    return { intent: RECIPE_INTENT, reason: "followUpAfterCards" };
  }

  // Installed clients still send a recipe intent from the fridge's "find
  // recipes" button. That request always carries the selected ingredients, so
  // the signature is unambiguous even though the text would not force a search.
  const selected = Array.isArray(selectedIngredients)
    ? selectedIngredients.filter(Boolean)
    : [];
  if (normalizeChatIntent(legacyIntent) === RECIPE_INTENT && selected.length > 0) {
    return { intent: RECIPE_INTENT, reason: "legacyFridgeButton" };
  }
  return { intent: "chat", reason: "model" };
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
    // App-supplied language. The dish pipeline searches in this language and
    // returns results adapted to it.
    language: cleanString(source.language, 32) || "en",
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

/**
 * Recipe mode forces the two-call sequence rather than hoping for it:
 * the first round may only read the fridge, the second may only recommend.
 * `tool_choice` pins a function, so each round is deterministic; the API has no
 * way to force a sequence in a single request.
 */
export function resolveRoundToolPolicy({ intent, round = 0 } = {}) {
  if (normalizeChatIntent(intent) !== RECIPE_INTENT) {
    return {
      tools: OPENAI_TOOLS,
      toolChoice: "auto",
      parallelToolCalls: false,
    };
  }

  if (round <= 0) {
    return {
      tools: [GET_FRIDGE_CONTENTS_TOOL],
      toolChoice: {
        type: "function",
        function: { name: "getFridgeContents" },
      },
      parallelToolCalls: false,
    };
  }

  return {
    tools: [RECOMMEND_RECIPES_TOOL],
    toolChoice: {
      type: "function",
      function: { name: RECOMMEND_RECIPES_TOOL_NAME },
    },
    parallelToolCalls: false,
  };
}
