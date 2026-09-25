// src/chat/recipeTextExtract.js
//
// Fallback recipe extraction for pages that have no Schema.org Recipe JSON-LD.
//
// Many Chinese and other non-English recipe sites publish the recipe as plain
// text (headings + lists) instead of structured markup. The JSON-LD parser
// returns nothing for those pages, so this module extracts a recipe from the
// already-fetched page text instead.
//
// Deliberately minimal: HTML -> text, a cheap "is this a recipe page" gate,
// then one model call that returns title/ingredients/instructions. Translation
// and calorie/time estimation stay in the existing pipeline.
//
// It is additive: nothing imports it yet. See the integration notes at the
// bottom for the two worker edits that use it as a fallback.

import { MODEL_RECIPE_TEXT_EXTRACT } from "../config/models.js";

const DEFAULT_MODEL = MODEL_RECIPE_TEXT_EXTRACT;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_PAGE_TEXT_CHARS = 16_000;
const MAX_TITLE_LENGTH = 180;
const MAX_INGREDIENTS = 30;
const MAX_INSTRUCTIONS = 12;
const MAX_LINE_LENGTH = 300;

const INGREDIENT_HEADINGS = [
  "ingredients",
  "ingredient",
  "zutaten",
  "ingrédients",
  "ingredientes",
  "ingredienti",
  "ingredienser",
  "ingrediënten",
  "ingredienten",
  "składniki",
  "ингредиенты",
  "malzemeler",
  "材料",
  "食材",
  "配料",
  "原料",
  "재료",
  "المكونات",
  "nguyên liệu",
  "bahan",
  "ส่วนผสม",
];

const INSTRUCTION_HEADINGS = [
  "instructions",
  "instruction",
  "directions",
  "method",
  "steps",
  "zubereitung",
  "préparation",
  "preparación",
  "preparazione",
  "instrucciones",
  "istruzioni",
  "modo de preparo",
  "bereiding",
  "przygotowanie",
  "приготовление",
  "hazırlanışı",
  "做法",
  "步骤",
  "方法",
  "制作方法",
  "作り方",
  "手順",
  "조리법",
  "만드는 법",
  "طريقة التحضير",
  "cách làm",
  "cara membuat",
  "วิธีทำ",
  "fremgangsmåte",
  "tilberedning",
];

function decodeHtmlEntities(value) {
  return String(value || "").replace(
    /&(#x?[0-9a-fA-F]+|amp|lt|gt|nbsp|quot|apos);/g,
    (match, body) => {
      const named = {
        amp: "&",
        lt: "<",
        gt: ">",
        nbsp: " ",
        quot: '"',
        apos: "'",
      };
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10
        );
        return Number.isSafeInteger(code) && code > 0
          ? String.fromCodePoint(code)
          : match;
      }
      const key = body.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key)
        ? named[key]
        : match;
    }
  );
}

/** Lightweight HTML to readable text. Kept local to avoid a tools.js cycle. */
export function stripHtmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|article|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map((line) => decodeHtmlEntities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Cheap, language-agnostic pre-filter over the raw HTML. The model is the real
 * extractor; this only avoids spending a model call on obvious non-recipe
 * pages. It is deliberately permissive because a false positive costs one
 * wasted call, while a false negative costs a whole recipe.
 */
export function looksLikeRecipePage(html) {
  const raw = String(html ?? "");
  if (!raw.trim()) return false;

  // Microdata is the clearest structured signal and works in any language.
  if (
    /itemprop\s*=\s*["']recipeIngredient/i.test(raw) &&
    /itemprop\s*=\s*["']recipeInstructions/i.test(raw)
  ) {
    return true;
  }

  const text = stripHtmlToText(raw);
  const lower = text.toLowerCase();
  const hasIngredients = INGREDIENT_HEADINGS.some((heading) =>
    lower.includes(heading)
  );
  const hasInstructions = INSTRUCTION_HEADINGS.some((heading) =>
    lower.includes(heading)
  );
  if (hasIngredients && hasInstructions) return true;

  // Structural fallback: list items that carry quantities (numbers) are a
  // strong, language-neutral sign of ingredients; require enough of them.
  const listItems = [...raw.matchAll(/<li[\s>][\s\S]*?<\/li>/gi)].map((match) =>
    stripHtmlToText(match[0])
  );
  const quantityItems = listItems.filter((line) => /\d/.test(line)).length;
  if (quantityItems >= 3 && listItems.length >= 5) return true;

  // Text-only pages with no list markup but a clearly numbered run.
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const shortLines = lines.filter((line) => line.length <= 120).length;
  const numbered = lines.filter((line) => /^\d+[.、)）]/.test(line)).length;
  return shortLines >= 5 && numbered >= 3;
}

/** On by default; set RECIPE_TEXT_EXTRACTION=false to disable. */
export function recipeTextExtractionEnabled(env = process.env) {
  const raw = String(env?.RECIPE_TEXT_EXTRACTION ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(?:0|false|no|off)$/.test(raw);
}

export function recipeTextExtractionModel(env = process.env) {
  return (
    String(env?.RECIPE_TEXT_EXTRACTION_MODEL || "").trim() || DEFAULT_MODEL
  );
}

function clipText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function clipList(value, maxItems, maxLength = MAX_LINE_LENGTH) {
  const output = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const text = clipText(entry, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function httpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function sourceName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Unknown source";
  }
}

/**
 * Bounds and validates model output into the same shape `parseRecipeJsonLd`
 * produces, so the rest of the pipeline is unchanged.
 */
export function normalizeExtractedRecipe(parsed, pageUrl = "") {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const url = httpUrl(pageUrl) || httpUrl(source.url);
  const title = clipText(source.title, MAX_TITLE_LENGTH);
  const ingredients = clipList(source.ingredients, MAX_INGREDIENTS);
  const instructions = clipList(source.instructions, MAX_INSTRUCTIONS);
  if (!title || !url || ingredients.length === 0) return null;

  return {
    title,
    url,
    source: sourceName(url),
    description: "",
    cuisines: [],
    mealTypes: [],
    diets: [],
    servings: null,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    caloriesPerServing: null,
    nutritionConfidence: "unknown",
    timeConfidence: "unknown",
    ingredients,
    instructions,
    warnings: [
      {
        code: "UNSTRUCTURED_RECIPE",
        message:
          "Recipe extracted from page text rather than structured publisher data.",
      },
    ],
  };
}

const EXTRACT_SYSTEM_PROMPT = `You extract a recipe from webpage text that has no structured recipe markup.
Return ONLY JSON shaped like:
{"title":"...","ingredients":["...","..."],"instructions":["...","..."]}
Rules:
- Keep the text in the page's original language; do not translate.
- One ingredient or instruction per array entry; do not merge steps.
- Preserve quantities and units exactly as written.
- If a field is missing, return an empty string or empty array.`;

function createJsonChatClient({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
} = {}) {
  return async function jsonChat(system, user, { signal } = {}) {
    const resolvedApiKey = apiKey ?? process.env.OPENAI_API_KEY;
    const resolvedModel = model ?? recipeTextExtractionModel();
    if (!resolvedApiKey) return null;
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Recipe text extraction timed out.")),
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

/**
 * Builds the extractor. Returns `[]` on anything unusable, so a page without a
 * recipe or a failed model call never breaks the recommendation request.
 */
export function createRecipeTextExtractor(options = {}) {
  const jsonChat = createJsonChatClient(options);
  return async function extractRecipeText(
    html,
    {
      pageUrl = "",
      language = "en",
      signal,
      maxChars = MAX_PAGE_TEXT_CHARS,
    } = {}
  ) {
    const text = stripHtmlToText(html).slice(0, maxChars);
    if (!looksLikeRecipePage(html)) return [];
    const parsed = await jsonChat(
      EXTRACT_SYSTEM_PROMPT,
      JSON.stringify({
        language: String(language || "en"),
        pageUrl: String(pageUrl || ""),
        text,
      }),
      { signal }
    );
    const recipe = normalizeExtractedRecipe(parsed, pageUrl);
    return recipe ? [recipe] : [];
  };
}

export const extractRecipeText = createRecipeTextExtractor();

/**
 * Caller-friendly entry point used by the fetch workers. Bakes in the feature
 * flag and the fail-open fallback.
 */
export async function extractRecipesFromPage(
  html,
  {
    pageUrl = "",
    language = "en",
    signal,
    enabled = recipeTextExtractionEnabled(),
    extract = extractRecipeText,
  } = {}
) {
  if (!enabled || typeof extract !== "function") return [];
  try {
    const result = await extract(html, { pageUrl, language, signal });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Integration notes (not applied)
// ---------------------------------------------------------------------------
//
// 1. src/chat/recipeDishSearch.js — in the fetch worker, after `parsePage`
//    returns no recipes:
//
//      import { extractRecipesFromPage } from "./recipeTextExtract.js";
//      ...
//      let recipes = parsed?.recipes || [];
//      if (recipes.length === 0) {
//        recipes = await extractRecipesFromPage(fetched.text, {
//          pageUrl: fetched.url || page.link,
//          language: normalizedLanguage,
//          signal: deadline.signal,
//        });
//      }
//      parsedPages[index] = recipes;
//
// 2. src/chat/recipeRecommendations.js — same fallback in fetchRecipePages,
//    using `recipeContext.language` (or the `language` dep) and `deadline.signal`.
//
// Add RECIPE_TEXT_EXTRACTION=false to disable, and RECIPE_TEXT_EXTRACTION_MODEL
// to change the model. Keep the call linked to the existing deadline signal so
// a disconnected client cancels the request.
