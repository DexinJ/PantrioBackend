// src/chat/recipeDedup.js
//
// Language-agnostic near-duplicate recipe detection.
//
// The recommendation engines already collapse exact URL/domain+title matches,
// but they still let the same dish through from two different sites (for
// example "Tomato Egg Stir Fry" on site-a.com and "Easy Tomato Egg Stir-Fry"
// on site-b.com). This module adds a dish-identity pass that runs after
// scoring and before the final diversity selection.
//
// It is intentionally additive: nothing imports it yet. See the integration
// notes at the bottom for the two edits that wire it into the inventory and
// dish pipelines.
//
// Design goals:
//   - No hard-coded language. Normalization and tokenization use Unicode
//     properties, so a new app language works without code changes.
//   - Deterministic first (fast, pure, testable), then an optional best-effort
//     model pass for cross-language and synonym cases that token overlap
//     cannot see (番茄炒蛋 vs "Tomato Egg Stir Fry", "omelette aux tomates").

import { MODEL_RECIPE_DEDUPE } from "../config/models.js";

const DEFAULT_MAX_EXTRA_TITLE_TOKENS = 2;
const DEFAULT_INGREDIENT_JACCARD = 0.5;
const DEFAULT_DEDUPE_MODEL = MODEL_RECIPE_DEDUPE;
const MAX_DEDUPE_LLM_RECIPES = 24;
const MAX_DEDUPE_LLM_INGREDIENTS = 6;
const DEFAULT_DEDUPE_TIMEOUT_MS = 12_000;

const WORD_RUN_PATTERN = /[\p{L}\p{N}]+/gu;

// ---------------------------------------------------------------------------
// Normalization + tokenization
// ---------------------------------------------------------------------------

/**
 * Unicode normalization only. NFKC folds full-width and compatibility forms;
 * lowercase handles Latin, Cyrillic, and Greek casing without assuming one
 * language. Diacritics are deliberately kept so diacritic-sensitive languages
 * (for example Vietnamese or Turkish) cannot collide.
 */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

/**
 * Script-aware token set.
 *
 * Space-segmented scripts (Latin, Cyrillic, Arabic, Devanagari, ...) keep
 * whole word runs. Scripts that are typically written without spaces (CJK,
 * Thai, Khmer, ...) get character bigrams and trigrams as a fuzzy fallback,
 * detected purely from the absence of whitespace rather than by naming a
 * language.
 */
export function tokenSet(value) {
  const text = normalizeText(value);
  if (!text) return new Set();

  const tokens = new Set();
  const runs = text.match(WORD_RUN_PATTERN) || [];
  const segmented = /\s/u.test(text);

  for (const run of runs) {
    tokens.add(run);
    if (!segmented && run.length >= 2) {
      const characters = [...run];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.add(characters[index] + characters[index + 1]);
      }
      for (let index = 0; index + 2 < characters.length; index += 1) {
        tokens.add(
          characters[index] + characters[index + 1] + characters[index + 2]
        );
      }
    }
  }
  return tokens;
}

function ingredientTokenSet(recipe) {
  const tokens = new Set();
  for (const line of recipe?.ingredients || []) {
    for (const token of tokenSet(line)) tokens.add(token);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  const [small, large] =
    left.size <= right.size ? [left, right] : [right, left];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function isSubset(left, right) {
  for (const token of left) {
    if (!right.has(token)) return false;
  }
  return true;
}

/**
 * True when two recipes are the same dish.
 *
 * Kept deliberately conservative so it never collapses two genuinely
 * different dishes: identical title word sets always match, and a title that
 * is contained in another with only a few extra modifier words matches only
 * when the ingredient lists also agree. Cross-language and synonym cases are
 * left to the optional model pass.
 */
export function sameDish(left, right, options = {}) {
  const ingredientJaccard =
    Number.isFinite(options.ingredientJaccard) && options.ingredientJaccard > 0
      ? options.ingredientJaccard
      : DEFAULT_INGREDIENT_JACCARD;
  const maxExtraTitleTokens =
    Number.isInteger(options.maxExtraTitleTokens) &&
    options.maxExtraTitleTokens >= 0
      ? options.maxExtraTitleTokens
      : DEFAULT_MAX_EXTRA_TITLE_TOKENS;

  if (left.title.size === 0 || right.title.size === 0) return false;
  // Identical word set = same dish, regardless of word order or punctuation.
  if (left.title.size === right.title.size && isSubset(left.title, right.title)) {
    return true;
  }

  // One title contained in the other with only a few extra modifier words.
  const leftInRight = isSubset(left.title, right.title);
  const rightInLeft = isSubset(right.title, left.title);
  if (!leftInRight && !rightInLeft) return false;
  if (
    Math.max(left.title.size, right.title.size) -
      Math.min(left.title.size, right.title.size) >
    maxExtraTitleTokens
  ) {
    return false;
  }

  if (left.ingredients.size > 0 && right.ingredients.size > 0) {
    return (
      isSubset(left.ingredients, right.ingredients) ||
      isSubset(right.ingredients, left.ingredients) ||
      jaccard(left.ingredients, right.ingredients) >= ingredientJaccard
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic clustering
// ---------------------------------------------------------------------------

function recipeScore(recipe) {
  return Number.isFinite(recipe?.score) ? recipe.score : 0;
}

function recipeCompleteness(recipe) {
  return (
    (recipe?.ingredients?.length || 0) +
    (recipe?.instructions?.length || 0) * 2 +
    (recipe?.caloriesPerServing == null ? 0 : 4) +
    (recipe?.totalMinutes == null ? 0 : 2)
  );
}

/** Keeps the strongest recipe in a cluster, with deterministic tie-breaks. */
export function pickRepresentative(cluster) {
  return cluster.reduce((best, recipe) => {
    const bestScore = recipeScore(best);
    const score = recipeScore(recipe);
    const bestCompleteness = recipeCompleteness(best);
    const completeness = recipeCompleteness(recipe);
    if (
      score > bestScore ||
      (score === bestScore && completeness > bestCompleteness) ||
      (score === bestScore &&
        completeness === bestCompleteness &&
        String(recipe?.url || "").localeCompare(String(best?.url || "")) < 0)
    ) {
      return recipe;
    }
    return best;
  });
}

/**
 * Groups recipes into same-dish clusters using union-find over pairwise
 * similarity. Input is the already-scored candidate pool, so the winner of a
 * cluster is the highest-scored representative.
 */
export function clusterBySimilarity(recipes, options = {}) {
  const list = Array.isArray(recipes) ? recipes : [];
  if (list.length < 2) return [list];

  const signatures = list.map((recipe) => ({
    title: tokenSet(recipe?.title),
    ingredients: ingredientTokenSet(recipe),
  }));
  const parent = list.map((_recipe, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent[rootLeft] = rootRight;
  };

  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      if (sameDish(signatures[left], signatures[right], options)) {
        union(left, right);
      }
    }
  }

  const byRoot = new Map();
  list.forEach((recipe, index) => {
    const root = find(index);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(recipe);
  });
  return [...byRoot.values()];
}

// ---------------------------------------------------------------------------
// Optional model pass (cross-language + synonyms)
// ---------------------------------------------------------------------------

/** On by default; set RECIPE_DEDUPE_LLM=false to disable. */
export function dedupeLlmEnabled(env = process.env) {
  const raw = String(env?.RECIPE_DEDUPE_LLM ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(?:0|false|no|off)$/.test(raw);
}

export function dedupeModel(env = process.env) {
  return (
    String(env?.RECIPE_DEDUPE_MODEL || "").trim() || DEFAULT_DEDUPE_MODEL
  );
}

const DEDUPE_SYSTEM_PROMPT = `You find duplicate dishes in a list of recipes so a user never sees the same dish twice from different websites.
Rules:
- Group ids that are the same dish, including the same dish written in another language, a different spelling, or with minor wording differences.
- Do NOT group two different dishes that merely share ingredients, cuisine, or a method.
- Put only the ids that are duplicates into a group; leave unique dishes out of every group.
Respond with ONLY JSON: {"groups":[[id,id],...]}`;

function createJsonChatClient({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_DEDUPE_TIMEOUT_MS,
  maxOutputTokens = 1_000,
} = {}) {
  return async function jsonChat(system, user, { signal } = {}) {
    const resolvedApiKey = apiKey ?? process.env.OPENAI_API_KEY;
    const resolvedModel = model ?? dedupeModel();
    if (!resolvedApiKey) return null;
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Recipe dedupe timed out.")),
      timeoutMs
    );
    timer.unref?.();
    try {
      const response = await fetchImpl(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resolvedApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: resolvedModel,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_completion_tokens: maxOutputTokens,
            temperature: 0,
          }),
          signal: controller.signal,
        }
      );
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
      return JSON.parse((fenced ? fenced[1] : content).trim());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  };
}

function normalizeLlmGroups(parsed, itemCount) {
  const groups = [];
  if (!parsed || !Array.isArray(parsed.groups)) return groups;
  for (const group of parsed.groups) {
    if (!Array.isArray(group)) continue;
    const ids = [
      ...new Set(
        group
          .map((id) => Number(id))
          .filter(
            (id) => Number.isInteger(id) && id >= 0 && id < itemCount
          )
      ),
    ];
    if (ids.length >= 2) groups.push(ids);
  }
  return groups;
}

function applyLlmMerge(clusters, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return clusters;
  const parent = clusters.map((_cluster, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left, right) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent[rootLeft] = rootRight;
  };
  for (const group of groups) {
    for (let index = 1; index < group.length; index += 1) {
      union(group[0], group[index]);
    }
  }

  const byRoot = new Map();
  clusters.forEach((cluster, index) => {
    const root = find(index);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(...cluster);
  });
  return [...byRoot.values()];
}

/**
 * Builds the model deduper. Receives deterministic clusters and returns groups
 * of cluster ids that are the same dish across languages or spellings.
 */
export function createRecipeDedupe(options = {}) {
  const jsonChat = createJsonChatClient(options);
  return async function dedupeRecipes(clusters, language, { signal } = {}) {
    const list = (Array.isArray(clusters) ? clusters : []).slice(
      0,
      MAX_DEDUPE_LLM_RECIPES
    );
    if (list.length < 2) return [];
    const items = list.map((cluster, id) => {
      const recipe = pickRepresentative(cluster);
      return {
        id,
        title: String(recipe?.title || "").slice(0, 180),
        ingredients: (recipe?.ingredients || [])
          .slice(0, MAX_DEDUPE_LLM_INGREDIENTS)
          .map((line) => String(line || "").slice(0, 120)),
      };
    });
    const parsed = await jsonChat(
      DEDUPE_SYSTEM_PROMPT,
      JSON.stringify({ language: String(language || "en"), items }),
      { signal }
    );
    return normalizeLlmGroups(parsed, items.length);
  };
}

export const dedupeRecipes = createRecipeDedupe();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Collapses near-duplicate dishes into one representative each. Returns the
 * same recipe objects (not copies), with the strongest kept per cluster.
 */
export async function dedupeSimilarDishes(
  recipes,
  {
    language = "en",
    maxExtraTitleTokens = DEFAULT_MAX_EXTRA_TITLE_TOKENS,
    ingredientJaccard = DEFAULT_INGREDIENT_JACCARD,
    llmDedupe = dedupeRecipes,
    llmEnabled = dedupeLlmEnabled(),
    signal,
  } = {}
) {
  const list = Array.isArray(recipes) ? recipes : [];
  if (list.length < 2) return { recipes: list, dropped: 0 };

  let clusters = clusterBySimilarity(list, {
    maxExtraTitleTokens,
    ingredientJaccard,
  });

  if (llmEnabled && typeof llmDedupe === "function") {
    try {
      const groups = await llmDedupe(clusters, language, { signal });
      clusters = applyLlmMerge(clusters, groups);
    } catch {
      // Best effort: keep the deterministic clusters.
    }
  }

  const kept = clusters.map(pickRepresentative);
  return { recipes: kept, dropped: list.length - kept.length };
}

// ---------------------------------------------------------------------------
// Integration notes (not applied)
// ---------------------------------------------------------------------------
//
// 1. src/chat/recipeRecommendations.js — run after the existing URL/domain
//    dedupe, before the meal-type/requested gates and selectDiverse:
//
//      import { dedupeSimilarDishes } from "./recipeDedup.js";
//      ...
//      const deduped = dedupeCandidates(
//        scoreCandidates(constrained.recipes, inputs, ideaPlan || [])
//      );
//      const dedupResult = await dedupeSimilarDishes(deduped, {
//        language: targetLanguage,
//        signal,
//      });
//      let pool = dedupResult.recipes;
//      // optional: surface dedupResult.dropped in meta
//
// 2. src/chat/recipeDishSearch.js — run after `scored` and before
//    `selectDiverse`:
//
//      import { dedupeSimilarDishes } from "./recipeDedup.js";
//      ...
//      const dedupResult = await dedupeSimilarDishes(scored, {
//        language: normalizedLanguage,
//        signal,
//      });
//      const selected = selectDiverse(
//        dedupResult.recipes,
//        wanted
//      ).map((candidate) => publicRecipe(...));
//
// The model pass is opt-out via RECIPE_DEDUPE_LLM=false; the deterministic
// pass always runs. Keep the call inside the existing abortable deadline so a
// disconnected client cancels the LLM request.
