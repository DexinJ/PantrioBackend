// src/chat/recipeHelperTasks.js
//
// Helper work, described instead of executed.
//
// When the user brings their own AI provider (custom API key or Apple AI) the
// server must not spend our OpenAI key on recipe helpers. It still owns search
// and page fetching, so instead of running a helper it hands the client a task
// descriptor: the same prompt this server would have used, plus the exact input
// it would have sent. The client runs it against the user's provider and merges
// the result.
//
// Prompts are imported from the modules that own them, so a BYO task can never
// drift from the pantrio prompt. Only `textExtraction` sends its result back,
// because a client-supplied recipe has to pass the server's validators,
// allergen/diet filters and dish gate before it can be shown.

import {
  ALIAS_SYSTEM_PROMPT,
  TRANSLATION_SYSTEM_PROMPT,
  INGREDIENT_VARIANTS_SYSTEM_PROMPT,
  needsTranslation,
} from "./recipeDishSearch.js";
import { IDEATION_SYSTEM_PROMPT } from "./recipeIdeation.js";
import { STRUCTURING_SYSTEM_PROMPT, MAX_MISSING_ITEMS } from "./recipeMissingItems.js";
import { ESTIMATION_SYSTEM_PROMPT } from "./recipeEstimation.js";
import { DEDUPE_SYSTEM_PROMPT } from "./recipeDedup.js";
import {
  EXTRACT_SYSTEM_PROMPT,
  MAX_PAGE_TEXT_CHARS,
  looksLikeRecipePage,
} from "./recipeTextExtract.js";

/**
 * Bumped whenever a prompt or an input shape changes. A client that does not
 * recognise the version must fall back to deterministic behaviour rather than
 * sending a mismatched shape.
 */
export const HELPER_TASK_VERSION = 1;

export const HELPER_TASK_KINDS = Object.freeze([
  "dishAliases",
  "ingredientVariants",
  "mealIdeas",
  "missingItems",
  "translation",
  "estimation",
  "dedupe",
  "textExtraction",
]);

/** Caps that keep a BYO client from burning the user's own quota. */
export const MAX_HELPER_TASKS = 12;
export const MAX_EXTRACTION_TASKS = 3;
export const EXTRACTION_EXCERPT_CHARS = 8_000;
export const MAX_TRANSLATION_STRINGS = 240;

/**
 * Pre-search tasks. The client must run these before it can call search, so
 * they are served from a manifest it fetches once per session. Inputs are
 * described rather than supplied: only the client knows the fridge, the dish
 * and the ingredient terms at that point.
 */
export function buildHelperManifest() {
  return {
    version: HELPER_TASK_VERSION,
    tasks: [
      {
        kind: "dishAliases",
        version: HELPER_TASK_VERSION,
        when: "preSearch",
        prompt: ALIAS_SYSTEM_PROMPT,
        expects: "json",
        maxOutputTokens: 400,
        inputTemplate: { dish: "<dish the user named>", language: "<app language>" },
        reads: "aliases",
      },
      {
        kind: "ingredientVariants",
        version: HELPER_TASK_VERSION,
        when: "preSearch",
        prompt: INGREDIENT_VARIANTS_SYSTEM_PROMPT,
        expects: "json",
        maxOutputTokens: 800,
        inputTemplate: { language: "<app language>", terms: ["<ingredient>"] },
        reads: "variants",
      },
      {
        kind: "mealIdeas",
        version: HELPER_TASK_VERSION,
        when: "preSearch",
        prompt: IDEATION_SYSTEM_PROMPT,
        expects: "json",
        maxOutputTokens: 1_600,
        inputTemplate: {
          inventory: ["<fridge item>"],
          language: "<app language>",
          mealType: "<optional>",
        },
        reads: "ideas",
      },
    ],
  };
}

function clip(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function missingLinesOf(recipe) {
  return (recipe?.missingIngredients || [])
    .map((line) => clip(String(line ?? ""), 160))
    .filter(Boolean)
    .slice(0, MAX_MISSING_ITEMS);
}

/**
 * Translation input mirrors the server translator: field-major, deduplicated,
 * and only strings written in the other script.
 */
export function collectTranslatableStrings(recipes, language) {
  const seen = new Set();
  const output = [];
  const push = (value) => {
    const text = clip(String(value ?? ""), 400);
    if (!text || seen.has(text)) return;
    if (!needsTranslation(text, language)) return;
    seen.add(text);
    output.push(text);
  };
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    push(recipe?.title);
    push(recipe?.source);
  }
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    for (const line of recipe?.ingredients || []) push(line);
  }
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    for (const step of recipe?.instructions || []) push(step);
  }
  return output.slice(0, MAX_TRANSLATION_STRINGS);
}

function cleanStringList(value, { maxItems = 8, maxLength = 120 } = {}) {
  const seen = new Set();
  const output = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const text = clip(String(entry ?? ""), maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Bounds the pre-search work a BYO client did on its own provider. This is
 * untrusted input: it only ever *seeds* the deterministic pipeline, and every
 * value is validated again by the same code that validates model output
 * (`isUsableDishAlias`, the variant-table builder, `normalizeIdeaPlan`).
 */
export function sanitizeRecipeHints(value) {
  const source = isPlainObject(value) ? value : {};
  const aliases = cleanStringList(source.aliases, { maxItems: 8, maxLength: 120 });

  const variantTable = {};
  const rawVariants = isPlainObject(source.variantTable) ? source.variantTable : {};
  let variants = 0;
  for (const key of Object.keys(rawVariants)) {
    if (variants >= 40) break;
    const term = clip(key, 80);
    const entry = rawVariants[key];
    if (!term || !isPlainObject(entry)) continue;
    variantTable[term] = {
      same: cleanStringList(entry.same, { maxItems: 6, maxLength: 80 }),
      notSame: cleanStringList(entry.notSame, { maxItems: 6, maxLength: 80 }),
    };
    variants += 1;
  }

  const ideas = [];
  for (const entry of Array.isArray(source.ideas) ? source.ideas : []) {
    if (ideas.length >= 5) break;
    if (!isPlainObject(entry)) continue;
    const dish = clip(String(entry.dish ?? ""), 100);
    const query = clip(String(entry.query ?? ""), 200);
    if (!dish || !query) continue;
    ideas.push({
      dish,
      query,
      coreIngredients: cleanStringList(entry.coreIngredients, {
        maxItems: 4,
        maxLength: 80,
      }),
    });
  }

  return { aliases, variantTable, ideas };
}

function estimationInput(recipes) {
  return (Array.isArray(recipes) ? recipes : [])
    .filter(
      (recipe) =>
        recipe?.caloriesPerServing == null || recipe?.totalMinutes == null
    )
    .slice(0, 12)
    .map((recipe, index) => ({
      index,
      title: clip(recipe?.title, 180),
      servings: Number.isFinite(recipe?.servings) ? recipe.servings : null,
      ingredients: (recipe?.ingredients || [])
        .slice(0, 20)
        .map((line) => clip(String(line ?? ""), 120)),
      instructions: (recipe?.instructions || [])
        .slice(0, 12)
        .map((step) => clip(String(step ?? ""), 160)),
    }));
}

function dedupeInput(recipes) {
  return (Array.isArray(recipes) ? recipes : []).slice(0, 24).map((recipe, id) => ({
    id,
    title: clip(recipe?.title, 180),
    ingredients: (recipe?.ingredients || [])
      .slice(0, 6)
      .map((line) => clip(String(line ?? ""), 120)),
  }));
}

/**
 * Post-search descriptors with their inputs already filled in. Returned on the
 * search response so the client can run whichever ones it supports; anything it
 * skips simply keeps the deterministic result the server already produced.
 */
export function buildPostSearchTasks(result, { language = "en" } = {}) {
  const recipes = Array.isArray(result?.recipes) ? result.recipes : [];
  const tasks = [];
  if (recipes.length === 0) return tasks;

  const lines = [...new Set(recipes.flatMap(missingLinesOf))];
  if (lines.length > 0) {
    tasks.push({
      id: "missingItems",
      kind: "missingItems",
      version: HELPER_TASK_VERSION,
      prompt: STRUCTURING_SYSTEM_PROMPT,
      expects: "json",
      maxOutputTokens: 2_000,
      input: { language, lines: lines.slice(0, 60) },
    });
  }

  const strings = collectTranslatableStrings(recipes, language);
  if (strings.length > 0) {
    tasks.push({
      id: "translation",
      kind: "translation",
      version: HELPER_TASK_VERSION,
      prompt: TRANSLATION_SYSTEM_PROMPT,
      expects: "json",
      maxOutputTokens: 2_000,
      input: { language, strings },
    });
  }

  const estimates = estimationInput(recipes);
  if (estimates.length > 0) {
    tasks.push({
      id: "estimation",
      kind: "estimation",
      version: HELPER_TASK_VERSION,
      prompt: ESTIMATION_SYSTEM_PROMPT,
      expects: "json",
      maxOutputTokens: 2_000,
      input: { recipes: estimates },
    });
  }

  const items = dedupeInput(recipes);
  if (items.length >= 2) {
    tasks.push({
      id: "dedupe",
      kind: "dedupe",
      version: HELPER_TASK_VERSION,
      prompt: DEDUPE_SYSTEM_PROMPT,
      expects: "json",
      maxOutputTokens: 800,
      input: { language, items },
    });
  }

  return tasks.slice(0, MAX_HELPER_TASKS);
}

/**
 * Pages that had no Schema.org recipe markup. The server keeps the page fetch
 * and the JSON-LD fast path; only the text pass is delegated.
 */
export function createExtractionCollector({
  language = "en",
  maxTasks = MAX_EXTRACTION_TASKS,
} = {}) {
  const tasks = [];
  /**
   * Drop-in replacement for `extractRecipesFromPage`: it records the task the
   * client should run and returns no recipes, so the BYO path never calls a
   * model of ours. The same "does this even look like a recipe page?" gate is
   * applied first, so a non-recipe page never becomes a task.
   */
  async function extractPageRecipes(text, { pageUrl = "", language: taskLanguage } = {}) {
    if (tasks.length >= maxTasks) return [];
    const html = typeof text === "string" ? text : "";
    if (!looksLikeRecipePage(html)) return [];
    const excerpt = html.slice(0, EXTRACTION_EXCERPT_CHARS);
    if (!excerpt.trim()) return [];
    tasks.push({
      id: `textExtraction:${tasks.length}`,
      kind: "textExtraction",
      version: HELPER_TASK_VERSION,
      prompt: EXTRACT_SYSTEM_PROMPT,
      expects: "json",
      maxOutputTokens: 2_000,
      input: {
        language: taskLanguage || language,
        pageUrl: String(pageUrl || ""),
        text: excerpt,
      },
      excerptChars: excerpt.length,
      maxSourceChars: MAX_PAGE_TEXT_CHARS,
    });
    // The recipes themselves arrive later, through the validated apply step.
    return [];
  }
  return {
    extractPageRecipes,
    tasks,
    get count() {
      return tasks.length;
    },
  };
}
