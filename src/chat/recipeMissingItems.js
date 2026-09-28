// src/chat/recipeMissingItems.js
//
// Turns a recipe's missing-ingredient lines into shopping-list items.
//
// The card ships lines like "2 cups beef broth" because that is what the
// publisher wrote. A button that adds them to the shopping list needs
// { name, quantity } instead, and splitting that deterministically needs a
// unit vocabulary nobody wants to maintain. So the split is delegated to the
// language service, in the same shape as the existing helpers in
// recipeDishSearch.js (alias expansion, ingredient variants, translation).
//
// This file is additive. Nothing references it yet; see the integration notes
// at the bottom for the two edits that wire it in.

import { OPENAI_API_KEY } from "../config/env.js";
import { MODEL_RECIPE_MISSING_ITEMS } from "../config/models.js";

export const MAX_MISSING_ITEMS = 30;
export const MAX_ITEM_NAME_LENGTH = 120;
export const MAX_ITEM_QUANTITY_LENGTH = 40;
export const MAX_ITEM_LINE_LENGTH = 160;

const DEFAULT_MODEL = MODEL_RECIPE_MISSING_ITEMS;
const MAX_LINES_PER_CALL = 60;
const MAX_CACHE_ENTRIES = 200;
const DEFAULT_TIMEOUT_MS = 12_000;

export const STRUCTURING_SYSTEM_PROMPT = `You turn recipe ingredient lines into shopping-list items.
For each line return:
- name: the ingredient, without the quantity and without packaging words
- quantity: the smallest amount a shopper can realistically buy, as a short value. Prefer a plain count of purchasable units ("1", "2", "3"). Use the natural count when the ingredient is sold by the piece ("3 eggs" -> "3", "2 onions" -> "2"). Otherwise use "1" for one package, can, bottle, or bunch. Never put a recipe-only portion or tasting amount such as "1/4 tsp", "1 tbsp", "1/2 cup", "to taste", or "as needed" into quantity.
Rules:
- Never invent an ingredient that is not in the line.
- quantity is only the purchasable amount. Leave parenthetical alternatives, brand notes, and commentary out of both fields rather than moving them into quantity.
- Keep a preparation note out of the name only when the ingredient still reads correctly without it ("1 lb flank steak, cut into strips" -> name "flank steak").
- Keep the line you were given in "line", unchanged.
Respond with ONLY JSON: {"items":[{"line":"...","name":"...","quantity":"..."}]}`;

/**
 * Structuring is on by default; set RECIPE_SHOPPING_STRUCTURING=false to turn
 * it off and fall back to the raw line as the item name.
 */
export function missingItemStructuringEnabled(env = process.env) {
  const raw = String(env?.RECIPE_SHOPPING_STRUCTURING ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(?:0|false|no|off)$/.test(raw);
}

export function missingItemModel(env = process.env) {
  return String(env?.RECIPE_SHOPPING_STRUCTURING_MODEL || "").trim() || DEFAULT_MODEL;
}

function clip(value, maxLength) {
  // Models sometimes answer with numbers ("quantity": 3). Coercing here keeps
  // the split instead of silently falling back to quantity "1".
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Lines are matched back tolerantly: models restate them with light edits. */
function normalizeLineKey(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    // Punctuation comes off only after trimming, so "beef broth, " matches.
    .replace(/[.,;:!?、。]+$/g, "")
    .trim();
}

function missingLinesFor(recipe) {
  return (recipe?.missingIngredients || [])
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_MISSING_ITEMS);
}

function createJsonChatClient({
  apiKey = OPENAI_API_KEY,
  model = missingItemModel(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputTokens = 2_000,
} = {}) {
  return async function jsonChat(system, user, { signal } = {}) {
    if (!apiKey) return null;
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Missing-item structuring timed out.")),
      timeoutMs
    );
    timer.unref?.();
    try {
      const response = await fetchImpl(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
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

/** Every line is still addable when the service cannot help. */
function fallbackItem(line) {
  return {
    line: clip(line, MAX_ITEM_LINE_LENGTH),
    name: clip(line, MAX_ITEM_NAME_LENGTH),
    quantity: "1",
  };
}

function normalizeParsedItems(parsed, lines) {
  const byLine = new Map();
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const lineByKey = new Map(lines.map((line) => [normalizeLineKey(line), line]));
  // If the model answered purely positionally, align by index instead.
  const positional =
    items.length === lines.length &&
    items.every((entry) => !String(entry?.line ?? "").trim());

  items.forEach((entry, index) => {
    const name = clip(entry?.name, MAX_ITEM_NAME_LENGTH);
    if (!name) return;
    const line =
      lineByKey.get(normalizeLineKey(entry?.line)) ??
      (positional ? lines[index] : undefined);
    if (!line) return;
    byLine.set(line, {
      line: clip(line, MAX_ITEM_LINE_LENGTH),
      name,
      quantity: clip(entry?.quantity, MAX_ITEM_QUANTITY_LENGTH) || "1",
    });
  });
  return byLine;
}

/**
 * Builds the structurer. Returns `{ line -> { name, quantity } }` for the lines
 * it was given, falling back per line when the service fails or omits one.
 */
export function createMissingItemStructurer(options = {}) {
  const jsonChat = createJsonChatClient(options);
  const cache = new Map();

  return async function structureMissingLines(lines, language, { signal } = {}) {
    const list = [
      ...new Set(
        (Array.isArray(lines) ? lines : [])
          .map((line) => String(line || "").trim())
          .filter(Boolean)
      ),
    ].slice(0, MAX_LINES_PER_CALL);

    const table = new Map();
    for (const line of list) table.set(line, fallbackItem(line));
    if (list.length === 0) return table;

    const key = `${String(language || "en")}|${list.join("\u0001")}`;
    if (cache.has(key)) return cache.get(key);

    const parsed = await jsonChat(
      STRUCTURING_SYSTEM_PROMPT,
      JSON.stringify({ language: String(language || "en"), lines: list }),
      { signal }
    );
    const structured = normalizeParsedItems(parsed, list);
    for (const [line, item] of structured) table.set(line, item);

    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, table);
    return table;
  };
}

export const structureMissingLines = createMissingItemStructurer();

/**
 * Adds `missingItems` next to `missingIngredients` on every recipe that has
 * missing lines. The lines stay where they are: the card and the modal display
 * them, and the model reads them.
 */
export async function decorateWithMissingItems(
  recipes,
  { structure = structureMissingLines, language = "en", signal } = {}
) {
  const list = Array.isArray(recipes) ? recipes : [];
  const lines = [];
  for (const recipe of list) {
    for (const line of recipe?.missingIngredients || []) {
      const text = String(line || "").trim();
      if (text) lines.push(text);
    }
  }
  if (lines.length === 0) return list;

  let table = new Map();
  if (typeof structure === "function") {
    try {
      table = (await structure(lines, language, { signal })) || table;
    } catch {
      table = new Map();
    }
  }

  return list.map((recipe) => {
    const missing = missingLinesFor(recipe);
    if (missing.length === 0) return recipe;
    return {
      ...recipe,
      missingItems: missing.map((line) => {
        const item = table.get(line) ?? fallbackItem(line);
        // The key is the canonical display line, so every item keeps its own
        // source text even when a custom structurer omitted it.
        return { ...item, line: clip(line, MAX_ITEM_LINE_LENGTH) };
      }),
    };
  });
}

/**
 * Wraps an engine result. Called from the tool wrapper, which both pipelines
 * pass through, so neither engine needs to know about shopping-list items.
 */
export async function withMissingItems(
  result,
  { enabled = missingItemStructuringEnabled(), ...rest } = {}
) {
  if (!result || !Array.isArray(result.recipes) || result.recipes.length === 0) {
    return result;
  }
  if (!enabled) {
    // Structuring off still produces addable items, just unparsed ones.
    return {
      ...result,
      recipes: result.recipes.map((recipe) => {
        const missing = missingLinesFor(recipe);
        return missing.length === 0
          ? recipe
          : { ...recipe, missingItems: missing.map(fallbackItem) };
      }),
    };
  }
  const recipes = await decorateWithMissingItems(result.recipes, rest);
  return { ...result, recipes };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
//
// Pantrio: `createRecommendRecipesTool` wraps whichever engine ran with
// `withMissingItems` (src/chat/tools.js), so the cards arrive with `{ name,
// quantity }` already split.
//
// BYO providers (custom API key / Apple AI): the REST route never runs this
// module. It returns a `missingItems` task descriptor from
// recipeHelperTasks.js instead, the client runs the same prompt on the user's
// provider, and the merged result carries the same shape. Without that task the
// card falls back to the publisher line as the item name — the behaviour
// `fallbackItem` exists to keep usable.
//
// The client keeps the field on persistence in fridge-manager/utils/recipeCards.js.
