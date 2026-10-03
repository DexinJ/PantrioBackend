// src/chat/recipeMethodSummary.js
//
// Turns a publisher recipe into an ORIGINAL, compressed cooking approach.
//
// This module exists to keep publisher step prose out of the product: the
// engines never return the steps themselves, only a short summary written in
// the app's own words, which recipeMethodGuard then checks for verbatim reuse.

import { MODEL_RECIPE_TEXT_EXTRACT } from "../config/models.js";
import { filterOriginalMethod } from "./recipeMethodGuard.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_TOKENS = 1_600;
const MAX_RECIPES_PER_CALL = 6;
const MAX_STEPS_PER_RECIPE = 12;
const MAX_STEP_CHARS = 300;
const MAX_BULLET_CHARS = 160;

export const MAX_METHOD_BULLETS = 4;

export const METHOD_SUMMARY_SYSTEM_PROMPT = `You write a short, original cooking approach for a published recipe.
You are given the recipe's title, ingredients and its published steps. Write a compressed approach in YOUR OWN WORDS.

Rules:
- Write at most ${MAX_METHOD_BULLETS} bullets. Fewer is better when the dish is simple.
- Each bullet is one short sentence. Keep only technique-critical facts: heat level, temperatures, times, and how to tell it is done.
- Do NOT copy, quote, or lightly reword the published steps. Do not translate them step by step.
- Do NOT list ingredients again or restate the ingredient list.
- Write in the requested language, regardless of the input language.
- If the steps are unusable, return an empty array rather than guessing.
Respond with ONLY JSON: {"recipes":[{"index":0,"method":["...","..."]}]}`;

/** On by default; set RECIPE_METHOD_SUMMARY=false to disable. */
export function recipeMethodSummaryEnabled(env = process.env) {
  const raw = String(env?.RECIPE_METHOD_SUMMARY ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(?:0|false|no|off)$/.test(raw);
}

export function recipeMethodModel(env = process.env) {
  return (
    String(env?.RECIPE_METHOD_MODEL || "").trim() || MODEL_RECIPE_TEXT_EXTRACT
  );
}

function clip(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function createJsonChatClient({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function jsonChat(system, user, { signal } = {}) {
    const resolvedApiKey = apiKey ?? process.env.OPENAI_API_KEY;
    const resolvedModel = model ?? recipeMethodModel();
    if (!resolvedApiKey) return null;
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Method summary timed out.")),
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
            max_completion_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.2,
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

function stepsOf(recipe, sourceSteps, index) {
  const provided = Array.isArray(sourceSteps) ? sourceSteps[index] : null;
  const steps = Array.isArray(provided)
    ? provided
    : Array.isArray(recipe?.instructions)
      ? recipe.instructions
      : [];
  return steps
    .slice(0, MAX_STEPS_PER_RECIPE)
    .map((step) => clip(String(step ?? ""), MAX_STEP_CHARS))
    .filter(Boolean);
}

/**
 * The model input. `sourceSteps` is the caller's escape hatch: once a recipe
 * has already passed through `publicRecipe` its `instructions` are gone, so the
 * engine hands the steps over separately.
 */
export function methodSummaryInput(recipes, { sourceSteps = [] } = {}) {
  return (Array.isArray(recipes) ? recipes : [])
    .slice(0, MAX_RECIPES_PER_CALL)
    .map((recipe, index) => ({
      index,
      title: clip(recipe?.title, 180),
      servings: Number.isFinite(recipe?.servings) ? recipe.servings : null,
      ingredients: (recipe?.ingredients || [])
        .slice(0, 20)
        .map((line) => clip(String(line ?? ""), 120)),
      steps: stepsOf(recipe, sourceSteps, index),
    }));
}

/**
 * Merges model output onto the recipe list and runs the originality guard.
 * Any missing entry leaves that recipe without a method — never with the
 * publisher's own text.
 */
export function applyMethodSummariesToRecipes(
  recipes,
  parsed,
  { sourceSteps = [] } = {}
) {
  const list = Array.isArray(recipes) ? recipes : [];
  const returned = Array.isArray(parsed?.recipes) ? parsed.recipes : [];
  if (returned.length === 0) return list;
  const output = list.map((recipe) => ({ ...recipe }));
  const sourceFor = (index, recipe) =>
    Array.isArray(sourceSteps[index])
      ? sourceSteps[index].join(" ")
      : [...(recipe?.instructions || []), recipe?.description || ""].join(" ");

  for (const entry of returned) {
    const index = Number(entry?.index);
    const target = Number.isInteger(index) ? output[index] : null;
    if (!target) continue;
    const method = (Array.isArray(entry.method) ? entry.method : [])
      .map((line) => clip(String(line ?? ""), MAX_BULLET_CHARS))
      .filter(Boolean)
      .slice(0, MAX_METHOD_BULLETS);
    if (method.length === 0) continue;
    target.method = filterOriginalMethod(method, sourceFor(index, target));
  }
  return output;
}

export function createRecipeMethodSummarizer(options = {}) {
  const jsonChat = createJsonChatClient(options);
  return async function summarizeRecipeMethods(
    recipes,
    language,
    { signal, sourceSteps = [] } = {}
  ) {
    const list = Array.isArray(recipes) ? recipes : [];
    if (list.length === 0) return list;
    const input = methodSummaryInput(list, { sourceSteps });
    if (input.every((entry) => entry.steps.length === 0)) return list;
    const parsed = await jsonChat(
      METHOD_SUMMARY_SYSTEM_PROMPT,
      JSON.stringify({ language: String(language || "en"), recipes: input }),
      { signal }
    );
    return applyMethodSummariesToRecipes(list, parsed, { sourceSteps });
  };
}

export const summarizeRecipeMethods = createRecipeMethodSummarizer();

/**
 * Engine hook: runs the summarizer when enabled and returns recipes carrying
 * `method`. Falls back to the untouched list on any failure, so a flaky
 * provider yields "no method" rather than a broken card or copied text.
 */
export async function applyMethodSummaries(
  recipes,
  { language = "en", enabled = true, summarize, signal, sourceSteps = [] } = {}
) {
  if (!enabled || typeof summarize !== "function") return recipes;
  try {
    const result = await summarize(recipes, language, { signal, sourceSteps });
    return Array.isArray(result) ? result : recipes;
  } catch {
    return recipes;
  }
}
