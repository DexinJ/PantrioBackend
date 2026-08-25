// src/chat/recipeEstimation.js
// Best-effort LLM estimation for recipe metadata (calories per serving and
// total time) that publishers did not provide in structured data. Estimates
// are always labeled as "ai_estimated" and never presented as verified.
import {
  OPENAI_API_KEY,
  RECIPE_AI_ESTIMATION_ENABLED,
  RECIPE_ESTIMATION_MODEL,
} from "../config/env.js";
import { safeJsonParse } from "../utils/json.js";

const MAX_ESTIMATED_RECIPES = 8;
const DEFAULT_ESTIMATION_TIMEOUT_MS = 8_000;
const MAX_ESTIMATION_TIMEOUT_MS = 15_000;
const CALORIE_MIN = 50;
const CALORIE_MAX = 3_000;
const TIME_MIN = 5;
const TIME_MAX = 720;
const MAX_ESTIMATION_OUTPUT_TOKENS = 2_000;

const ESTIMATION_SYSTEM_PROMPT = `You estimate nutrition and total cooking time for home-cooking recipes.
For each recipe in the input JSON, return an estimate object with:
- caloriesPerServing: integer calories in one typical serving (50-3000)
- totalMinutes: integer total prep plus cook time in minutes (5-720)
Use the title, ingredient amounts, servings/yield, and instructions. When the data
is not enough to estimate a field, use null.
Respond with ONLY JSON shaped like:
{"estimates":[{"index":0,"caloriesPerServing":420,"totalMinutes":35}]}
Include every index from the input. Never include text outside the JSON.`;

export function recipeEstimationEnabled() {
  return RECIPE_AI_ESTIMATION_ENABLED;
}

function clipPromptText(value, maxLength = 120) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function buildEstimationPayload(recipes) {
  return recipes.map((recipe, index) => ({
    index,
    title: clipPromptText(recipe?.title, 180),
    servings: Number.isFinite(recipe?.servings) ? recipe.servings : null,
    ingredients: (Array.isArray(recipe?.ingredients) ? recipe.ingredients : [])
      .slice(0, 15)
      .map((entry) => clipPromptText(entry, 120)),
    instructions: (Array.isArray(recipe?.instructions)
      ? recipe.instructions
      : []
    )
      .slice(0, 8)
      .map((entry) => clipPromptText(entry, 220)),
  }));
}

function createLinkedController(signal, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("Recipe metadata estimation timed out.")),
    timeoutMs
  );
  timeout.unref?.();
  return {
    controller,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function callOpenAiCompletions(messages, { model, signal, timeoutMs }) {
  const linked = createLinkedController(signal, timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: MAX_ESTIMATION_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: linked.controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `The AI estimation service returned HTTP ${response.status}.`,
      };
    }
    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "The AI estimation service returned no content." };
    }
    return { ok: true, content };
  } catch (error) {
    if (linked.controller.signal.aborted) {
      return { ok: false, error: "Recipe metadata estimation was cancelled." };
    }
    return { ok: false, error: error?.message || "Recipe metadata estimation failed." };
  } finally {
    linked.cleanup();
  }
}

function boundedInteger(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function parseEstimateResponse(content) {
  const cleaned = String(content || "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const parsed = safeJsonParse(cleaned);
  if (!parsed.ok) return null;
  const source = Array.isArray(parsed.value)
    ? parsed.value
    : Array.isArray(parsed.value?.estimates)
      ? parsed.value.estimates
      : null;
  if (!source) return null;

  const entries = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!Number.isInteger(entry.index) || entry.index < 0) continue;
    const caloriesPerServing = boundedInteger(
      entry.caloriesPerServing,
      CALORIE_MIN,
      CALORIE_MAX
    );
    const totalMinutes = boundedInteger(entry.totalMinutes, TIME_MIN, TIME_MAX);
    if (caloriesPerServing == null && totalMinutes == null) continue;
    entries.push({ index: entry.index, caloriesPerServing, totalMinutes });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Estimates missing calories/time for recipes and returns a Map keyed by the
 * recipe's index in the `recipes` array. Never throws: upstream and parse
 * failures resolve to `{ ok: false }` so the recommendation pipeline can
 * continue with soft penalties and warnings.
 */
export async function estimateRecipeMetadata(
  recipes,
  {
    signal,
    timeoutMs = DEFAULT_ESTIMATION_TIMEOUT_MS,
    model = RECIPE_ESTIMATION_MODEL,
    callOpenAI = callOpenAiCompletions,
    maxRecipes = MAX_ESTIMATED_RECIPES,
  } = {}
) {
  const candidates = Array.isArray(recipes) ? recipes : [];
  const missing = [];
  for (const recipe of candidates) {
    if (
      recipe &&
      (recipe.caloriesPerServing == null || recipe.totalMinutes == null)
    ) {
      missing.push(recipe);
      if (missing.length >= Math.max(1, maxRecipes)) break;
    }
  }
  const missingCount = candidates.filter(
    (recipe) =>
      recipe && (recipe.caloriesPerServing == null || recipe.totalMinutes == null)
  ).length;
  const skippedCount = Math.max(0, missingCount - missing.length);

  if (missing.length === 0) {
    return {
      ok: true,
      estimates: new Map(),
      estimatedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
  }

  const normalizedTimeoutMs = Math.min(
    Math.max(
      Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_ESTIMATION_TIMEOUT_MS,
      1_000
    ),
    MAX_ESTIMATION_TIMEOUT_MS
  );
  const messages = [
    { role: "system", content: ESTIMATION_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({ recipes: buildEstimationPayload(missing) }),
    },
  ];

  let response;
  try {
    response = await callOpenAI(messages, {
      model,
      signal,
      timeoutMs: normalizedTimeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      estimates: new Map(),
      estimatedCount: 0,
      failedCount: missing.length,
      skippedCount,
      error: error?.message || "Recipe metadata estimation failed.",
    };
  }
  if (!response?.ok || typeof response.content !== "string") {
    return {
      ok: false,
      estimates: new Map(),
      estimatedCount: 0,
      failedCount: missing.length,
      skippedCount,
      error: response?.error,
    };
  }

  const entries = parseEstimateResponse(response.content);
  if (!entries) {
    return {
      ok: false,
      estimates: new Map(),
      estimatedCount: 0,
      failedCount: missing.length,
      skippedCount,
      error: "The AI estimation response could not be parsed.",
    };
  }

  const estimates = new Map();
  for (const entry of entries) {
    if (entry.index >= missing.length) continue;
    if (!estimates.has(entry.index)) {
      estimates.set(entry.index, {
        caloriesPerServing: entry.caloriesPerServing,
        totalMinutes: entry.totalMinutes,
      });
    }
  }
  return {
    ok: true,
    estimates,
    estimatedCount: estimates.size,
    failedCount: missing.length - estimates.size,
    skippedCount,
  };
}

/**
 * Mutates recipes in place from an estimates Map keyed by array index. Adds
 * ai_estimated confidence labels and replaces missing-metadata warnings with
 * explicit "estimated by AI" warnings. Returns how many recipes changed.
 */
export function applyRecipeEstimates(recipes, estimates) {
  if (!(estimates instanceof Map)) return 0;
  let applied = 0;
  for (const [index, values] of estimates) {
    const recipe = recipes?.[index];
    if (!recipe) continue;
    let changed = false;
    if (recipe.caloriesPerServing == null && values.caloriesPerServing != null) {
      recipe.caloriesPerServing = values.caloriesPerServing;
      recipe.nutritionConfidence = "ai_estimated";
      recipe.warnings = (recipe.warnings || []).filter(
        (entry) => entry?.code !== "CALORIES_NOT_PROVIDED"
      );
      recipe.warnings.push({
        code: "CALORIES_AI_ESTIMATED",
        message: "Calories were estimated by AI and are not verified by the publisher.",
      });
      changed = true;
    }
    if (recipe.totalMinutes == null && values.totalMinutes != null) {
      recipe.totalMinutes = values.totalMinutes;
      recipe.timeConfidence = "ai_estimated";
      recipe.warnings = (recipe.warnings || []).filter(
        (entry) => entry?.code !== "TIME_NOT_PROVIDED"
      );
      recipe.warnings.push({
        code: "TIME_AI_ESTIMATED",
        message: "Total time was estimated by AI and is not verified by the publisher.",
      });
      changed = true;
    }
    if (changed) applied += 1;
  }
  return applied;
}

/**
 * Default dependency for the recommendation engine: estimate missing metadata
 * and apply it in one step. Mutates the passed recipes and returns
 * `{ ok, estimatedCount, failedCount, estimates }`.
 */
export async function estimateAndApplyRecipeMetadata(recipes, options = {}) {
  const result = await estimateRecipeMetadata(recipes, options);
  if (!result.ok) {
    return {
      ok: false,
      estimatedCount: 0,
      failedCount: recipes.length,
      estimates: result.estimates,
      error: result.error,
    };
  }
  const appliedCount = applyRecipeEstimates(recipes, result.estimates);
  return {
    ok: true,
    estimatedCount: appliedCount,
    failedCount: recipes.length - appliedCount,
    estimates: result.estimates,
  };
}
