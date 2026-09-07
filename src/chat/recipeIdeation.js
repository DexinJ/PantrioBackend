// src/chat/recipeIdeation.js
// Optional LLM step that turns a fridge inventory plus current-meal
// constraints into concrete dish ideas. Each idea carries a canonical-English
// dish search query and core ingredients so the retrieval pipeline can verify
// that a real published recipe backs the idea before anything is shown to the
// user. Ideas themselves are never returned as recommendations.
import {
  OPENAI_API_KEY,
  RECIPE_IDEATION_ENABLED,
  RECIPE_IDEATION_MODEL,
} from "../config/env.js";
import { safeJsonParse } from "../utils/json.js";

export const MAX_IDEAS = 5;
const MAX_IDEATION_TIMEOUT_MS = 8_000;
const MAX_IDEATION_OUTPUT_TOKENS = 1_600;
const MAX_INVENTORY_ITEMS_IN_PROMPT = 20;
const MAX_EXCLUDED_TERMS_IN_PROMPT = 20;

const IDEATION_SYSTEM_PROMPT = `You turn a home fridge inventory into concrete meal ideas that exist as real published recipes.

Rules:
- Propose 3 to 5 distinct ideas. Cover as many fridge items as practical across the ideas, but do not force every item into one dish.
- Respect the requested meal type: dinner ideas must be main dishes, not beverages, snacks, or desserts unless the user asked for them.
- Use canonical English dish and ingredient names. If the user's items or constraints are in another language (for example Chinese), translate them: 番茄炒蛋 -> tomato and egg; 鸡肉 -> chicken.
- Never propose a dish containing an excluded ingredient, an allergen, or an ingredient the user's saved diet forbids.
- For every idea return:
  - dish: a short display name,
  - query: ONE specific English web-search query that will find a real recipe for this dish (for example "yogurt marinated chicken recipe"). Never a raw list of fridge items.
  - coreIngredients: 1-4 canonical English ingredients that must appear in the recipe.
- Never invent brand names, restaurants, or recipe sources.

Respond with ONLY JSON shaped like:
{"ideas":[{"dish":"Yogurt marinated chicken","query":"yogurt marinated chicken recipe","coreIngredients":["chicken","yogurt"]}]}`;

function clip(value, maxLength = 120) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

export function recipeIdeationEnabled() {
  return RECIPE_IDEATION_ENABLED;
}

function cleanIdea(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const dish = clip(value.dish, 100);
  const query = clip(value.query, 200);
  if (!dish || !query) return null;
  const coreIngredients = [];
  for (const entry of Array.isArray(value.coreIngredients)
    ? value.coreIngredients
    : []) {
    const ingredient = clip(entry, 80);
    if (!ingredient) continue;
    if (
      !coreIngredients.some(
        (existing) => existing.toLowerCase() === ingredient.toLowerCase()
      )
    ) {
      coreIngredients.push(ingredient);
    }
    if (coreIngredients.length >= 4) break;
  }
  if (coreIngredients.length === 0) return null;
  return { dish, query, coreIngredients };
}

/** Validates, deduplicates, and bounds raw LLM output into Idea objects. */
export function normalizeIdeas(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.ideas)
      ? value.ideas
      : [];
  const ideas = [];
  const seenQueries = new Set();
  for (const entry of source) {
    const idea = cleanIdea(entry);
    if (!idea) continue;
    const key = idea.query.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    ideas.push(idea);
    if (ideas.length >= MAX_IDEAS) break;
  }
  return ideas;
}

function buildIdeationPayload(inputs) {
  const safeList = (value, maxItems = 20) =>
    Array.isArray(value)
      ? value
          .map((entry) => clip(typeof entry === "string" ? entry : entry?.name, 80))
          .filter(Boolean)
          .slice(0, maxItems)
      : [];
  const excluded = [
    ...safeList(inputs?.allergens),
    ...safeList(inputs?.dietaryPatterns),
    ...safeList(inputs?.excludedIngredients),
    ...safeList(inputs?.dislikedIngredients),
  ];
  const uniqueExcluded = [];
  for (const entry of excluded) {
    const key = entry.toLowerCase();
    if (!uniqueExcluded.some((existing) => existing.toLowerCase() === key)) {
      uniqueExcluded.push(entry);
    }
    if (uniqueExcluded.length >= MAX_EXCLUDED_TERMS_IN_PROMPT) break;
  }

  return {
    inventory: safeList(inputs?.inventory, MAX_INVENTORY_ITEMS_IN_PROMPT),
    mealType: inputs?.mealType || null,
    preferredCuisines: safeList(inputs?.requestedCuisines, 5),
    energyPreference: inputs?.energyPreference || "any",
    maxCaloriesPerServing: inputs?.maxCaloriesPerServing ?? null,
    maxPrepMinutes: inputs?.maxPrepMinutes ?? null,
    skillLevel: inputs?.skillLevel || null,
    cookingMethod: inputs?.cookingMethod || null,
    maxIngredients: inputs?.maxIngredients ?? null,
    servings: inputs?.servings ?? null,
    mustUseIngredients: safeList(inputs?.mustUseIngredients, 10),
    neverInclude: uniqueExcluded,
  };
}

function stripJsonFence(content) {
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text;
}

function createLinkedController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    forwardAbort();
  } else {
    parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Recipe ideation timed out."));
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

/**
 * Generates bounded dish ideas from normalized recipe inputs.
 *
 * Best-effort by design: any failure returns `{ ok:false, ideas: [] }` so the
 * caller can fall back to the legacy ingredient-token query path.
 */
export async function generateRecipeIdeas(inputs, { signal } = {}) {
  const linked = createLinkedController(signal, MAX_IDEATION_TIMEOUT_MS);
  try {
    const payload = buildIdeationPayload(inputs);
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RECIPE_IDEATION_MODEL,
        messages: [
          { role: "system", content: IDEATION_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
        max_completion_tokens: MAX_IDEATION_OUTPUT_TOKENS,
        temperature: 0.8,
      }),
      signal: linked.signal,
    });
    if (!response.ok) {
      return { ok: false, ideas: [], error: `Ideation request failed (${response.status}).` };
    }
    const data = await response.json().catch(() => null);
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.message?.text ??
      "";
    const parsed = safeJsonParse(stripJsonFence(content));
    const ideas = normalizeIdeas(parsed.ok ? parsed.value : null);
    return ideas.length > 0
      ? { ok: true, ideas }
      : { ok: false, ideas: [], error: "Ideation returned no usable ideas." };
  } catch (error) {
    return {
      ok: false,
      ideas: [],
      error:
        linked.timedOut || linked.signal.aborted
          ? "Recipe ideation timed out."
          : "Recipe ideation is temporarily unavailable.",
    };
  } finally {
    linked.cleanup();
  }
}
