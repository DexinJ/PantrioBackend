const MAX_JSON_LD_SCRIPTS = 40;
const MAX_JSON_LD_CHARS = 512 * 1024;
const MAX_RECIPES_PER_PAGE = 6;
const MAX_INGREDIENTS = 80;
const MAX_INSTRUCTIONS = 60;

function clipString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
    .slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => {
      const numeric = Number(code);
      return Number.isSafeInteger(numeric) && numeric > 0
        ? String.fromCodePoint(numeric)
        : "";
    });
}

function stripInlineHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "));
}

function stringValues(value, { split = false } = {}) {
  const values = [];
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (typeof entry === "string" || typeof entry === "number") {
      const text = clipString(stripInlineHtml(String(entry)), 160);
      if (!text) return;
      if (split) {
        for (const part of text.split(/[,;|]/)) {
          const normalized = clipString(part, 80);
          if (normalized) values.push(normalized);
        }
      } else {
        values.push(text);
      }
      return;
    }
    if (entry && typeof entry === "object") {
      visit(entry.name ?? entry["@value"] ?? entry.value);
    }
  };
  visit(value);
  return [...new Set(values)];
}

function typeIncludesRecipe(value) {
  return stringValues(value).some(
    (type) => type.split(/[\/#:]/).at(-1)?.toLowerCase() === "recipe"
  );
}

function findRecipeNodes(value, output, seen, depth = 0) {
  if (!value || depth > 12 || output.length >= MAX_RECIPES_PER_PAGE) return;
  if (Array.isArray(value)) {
    for (const entry of value) findRecipeNodes(entry, output, seen, depth + 1);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (typeIncludesRecipe(value["@type"])) output.push(value);
  for (const child of Object.values(value)) {
    if (output.length >= MAX_RECIPES_PER_PAGE) break;
    if (child && typeof child === "object") {
      findRecipeNodes(child, output, seen, depth + 1);
    }
  }
}

function absoluteHttpUrl(value, pageUrl) {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? value.url || value["@id"]
        : "";
  if (!candidate && !pageUrl) return "";
  try {
    const url = new URL(candidate || pageUrl, pageUrl || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function parseIsoDurationMinutes(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = text.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  );
  if (iso) {
    const minutes =
      Number(iso[1] || 0) * 1440 +
      Number(iso[2] || 0) * 60 +
      Number(iso[3] || 0) +
      Number(iso[4] || 0) / 60;
    return Number.isFinite(minutes) && minutes > 0
      ? Math.max(1, Math.round(minutes))
      : null;
  }

  const days = Number(text.match(/(\d+(?:\.\d+)?)\s*d(?:ays?)?\b/i)?.[1] || 0);
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\b/i)?.[1] || 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b/i)?.[1] || 0);
  const total = days * 1440 + hours * 60 + minutes;
  return Number.isFinite(total) && total > 0 ? Math.max(1, Math.round(total)) : null;
}

function parseCalories(value) {
  const raw = stringValues(value)[0] || "";
  if (!raw || (/\bkj\b/i.test(raw) && !/\b(?:kcal|calorie)/i.test(raw))) {
    return null;
  }
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const calories = Math.round(Number(match[1]));
  return Number.isSafeInteger(calories) && calories > 0 && calories <= 20_000
    ? calories
    : null;
}

function parseServings(value) {
  const raw = stringValues(value)[0] || "";
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const servings = Number(match[1]);
  return Number.isFinite(servings) && servings > 0 && servings <= 100
    ? servings
    : null;
}

function flattenInstructions(value, output, depth = 0) {
  if (value == null || depth > 10 || output.length >= MAX_INSTRUCTIONS) return;
  if (Array.isArray(value)) {
    for (const entry of value) flattenInstructions(entry, output, depth + 1);
    return;
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = clipString(stripInlineHtml(String(value)), 1_000);
    if (text) output.push(text);
    return;
  }
  if (typeof value !== "object") return;

  const nested = value.itemListElement ?? value.steps;
  if (nested != null) {
    flattenInstructions(nested, output, depth + 1);
    return;
  }
  if (value.text != null) {
    flattenInstructions(value.text, output, depth + 1);
    return;
  }
  if (value.name != null) flattenInstructions(value.name, output, depth + 1);
}

function normalizedIngredients(value) {
  const raw = Array.isArray(value) ? value : [value];
  const ingredients = [];
  for (const entry of raw) {
    if (ingredients.length >= MAX_INGREDIENTS) break;
    if (typeof entry !== "string" && typeof entry !== "number") continue;
    const split = String(entry).split(/[\r\n]+/);
    for (const line of split) {
      const text = clipString(stripInlineHtml(line), 300);
      if (text && !ingredients.includes(text)) ingredients.push(text);
      if (ingredients.length >= MAX_INGREDIENTS) break;
    }
  }
  return ingredients;
}

function normalizedDiets(value) {
  return stringValues(value, { split: true }).map((entry) =>
    clipString(
      entry
        .split(/[\/#]/)
        .at(-1)
        .replace(/Diet$/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2"),
      80
    )
  );
}

function sourceName(node, url) {
  const publisher = stringValues(node.publisher)[0];
  if (publisher) return publisher;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Unknown source";
  }
}

function normalizeRecipeNode(node, pageUrl) {
  const url = absoluteHttpUrl(
    node.url || node.mainEntityOfPage || node["@id"],
    pageUrl
  );
  const title = clipString(
    stripInlineHtml(node.name || node.headline || ""),
    180
  );
  const ingredients = normalizedIngredients(
    node.recipeIngredient ?? node.ingredients
  );
  const instructions = [];
  flattenInstructions(node.recipeInstructions ?? node.instructions, instructions);

  const prepMinutes = parseIsoDurationMinutes(node.prepTime);
  const cookMinutes = parseIsoDurationMinutes(node.cookTime);
  const declaredTotal = parseIsoDurationMinutes(node.totalTime);
  const totalMinutes = declaredTotal ??
    (prepMinutes != null || cookMinutes != null
      ? (prepMinutes || 0) + (cookMinutes || 0)
      : null);
  const caloriesPerServing = parseCalories(node.nutrition?.calories);
  const servings = parseServings(node.recipeYield ?? node.yield);
  const warnings = [];

  if (caloriesPerServing == null) {
    warnings.push({
      code: "CALORIES_NOT_PROVIDED",
      message: "The publisher did not provide parseable calories per serving.",
    });
  } else if (servings == null) {
    warnings.push({
      code: "SERVING_BASIS_UNCLEAR",
      message: "Publisher calories are shown, but the serving yield is unclear.",
    });
  }
  if (totalMinutes == null) {
    warnings.push({
      code: "TIME_NOT_PROVIDED",
      message: "The publisher did not provide a parseable total time.",
    });
  }
  if (instructions.length === 0) {
    warnings.push({
      code: "INSTRUCTIONS_NOT_PROVIDED",
      message: "Structured cooking instructions were not available on the page.",
    });
  }

  return {
    title,
    url,
    source: sourceName(node, url || pageUrl),
    description: clipString(stripInlineHtml(node.description || ""), 360),
    cuisines: stringValues(node.recipeCuisine, { split: true }).slice(0, 8),
    mealTypes: stringValues(node.recipeCategory, { split: true }).slice(0, 8),
    diets: normalizedDiets(node.suitableFor).slice(0, 8),
    servings,
    prepMinutes,
    cookMinutes,
    totalMinutes,
    caloriesPerServing,
    nutritionConfidence:
      caloriesPerServing == null ? "unknown" : "publisher_provided",
    ingredients,
    instructions: [...new Set(instructions)].slice(0, MAX_INSTRUCTIONS),
    warnings,
  };
}

/**
 * Extracts normalized Schema.org Recipe objects from a fetched HTML page.
 * Malformed JSON-LD is skipped; no markup is evaluated as code.
 */
export function parseRecipeJsonLd(
  html,
  { pageUrl = "", maxRecipes = MAX_RECIPES_PER_PAGE } = {}
) {
  const boundedMaxRecipes = Number.isSafeInteger(maxRecipes)
    ? Math.max(1, Math.min(MAX_RECIPES_PER_PAGE, maxRecipes))
    : MAX_RECIPES_PER_PAGE;
  const recipes = [];
  const seenNodes = new Set();
  let scriptsExamined = 0;
  let malformedScripts = 0;
  let recipeNodesFound = 0;
  let truncatedScripts = 0;
  const scriptPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;[^"']*)?["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

  for (const match of String(html || "").matchAll(scriptPattern)) {
    if (scriptsExamined >= MAX_JSON_LD_SCRIPTS || recipes.length >= boundedMaxRecipes) {
      break;
    }
    scriptsExamined += 1;
    let raw = String(match[1] || "")
      .trim()
      .replace(/^<!--/, "")
      .replace(/-->$/, "")
      .replace(/^\/\*<!\[CDATA\[\*\//, "")
      .replace(/\/\*\]\]>\*\/$/, "")
      .trim();
    if (raw.length > MAX_JSON_LD_CHARS) {
      raw = raw.slice(0, MAX_JSON_LD_CHARS);
      truncatedScripts += 1;
    }
    if (!raw) continue;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      malformedScripts += 1;
      continue;
    }

    const nodes = [];
    findRecipeNodes(data, nodes, seenNodes);
    recipeNodesFound += nodes.length;
    for (const node of nodes) {
      if (recipes.length >= boundedMaxRecipes) break;
      const recipe = normalizeRecipeNode(node, pageUrl);
      if (recipe.title && recipe.url && recipe.ingredients.length > 0) {
        recipes.push(recipe);
      }
    }
  }

  return {
    recipes,
    diagnostics: {
      scriptsExamined,
      malformedScripts,
      truncatedScripts,
      recipeNodesFound,
    },
  };
}
