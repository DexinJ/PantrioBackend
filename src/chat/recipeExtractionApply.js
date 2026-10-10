// src/chat/recipeExtractionApply.js
//
// The return path for a BYO client's text-extraction work.
//
// Pages without Schema.org markup are handed to the client as
// `textExtraction` tasks, because the client runs them on the user's own
// provider. The result is untrusted input again: this module re-applies the
// same validation the server would have applied to its own model output —
// bounded shape, allergen/diet constraints, and the dish identity gate — before
// a recipe can be shown. A tampered client cannot inject a recipe that skips
// those rules.

import {
  buildIngredientExclusions,
  buildIngredientVariants,
  createConstraintRules,
  createIngredientMatcher,
  filterByDish,
  findConstraintConflict,
  normalizeDishText,
} from "./recipeDishSearch.js";
import { normalizeExtractedRecipe } from "./recipeTextExtract.js";
import { MAX_DISH_RESULT_COUNT } from "./recipeDishSearch.js";

/** Bounds on what a client may send back. */
export const MAX_APPLY_RECIPES = 12;
export const MAX_APPLY_EXTRACTIONS = 3;

function warning(code, message) {
  return { code, message };
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function urlKey(value) {
  return cleanText(value, 500).toLowerCase().replace(/\/+$/, "");
}

function preferenceTerms(preferences = {}) {
  const explicit = preferences?.explicit && typeof preferences.explicit === "object"
    ? preferences.explicit
    : {};
  const list = (value, max) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => cleanText(String(entry ?? ""), 80))
      .filter(Boolean)
      .slice(0, max);
  return {
    allergens: list(explicit.allergens, 20),
    excludedIngredients: list(explicit.excludedIngredients, 30),
    dietaryPatterns: list(explicit.dietaryPatterns, 20),
    dislikedIngredients: list(explicit.dislikedIngredients, 30),
  };
}

/**
 * Validates the client's extractions and merges them into the recipes the
 * search already returned. Returns the (possibly unchanged) list plus warnings
 * describing anything that was refused.
 */
export function applyClientExtractions({
  recipes = [],
  extractions = [],
  dishQuery = "",
  preferences = {},
} = {}) {
  const warnings = [];
  const current = (Array.isArray(recipes) ? recipes : []).slice(
    0,
    MAX_APPLY_RECIPES
  );
  const incoming = (Array.isArray(extractions) ? extractions : []).slice(
    0,
    MAX_APPLY_EXTRACTIONS
  );
  if (incoming.length === 0) return { recipes: current, warnings };

  const terms = preferenceTerms(preferences);
  const termSet = [
    ...new Set([
      ...terms.allergens,
      ...terms.excludedIngredients,
      ...terms.dislikedIngredients,
    ]),
  ];
  const rules = createConstraintRules(terms);
  const matcher = createIngredientMatcher(
    buildIngredientVariants(termSet),
    buildIngredientExclusions(termSet)
  );

  const accepted = [];
  let refused = 0;
  let filtered = 0;
  for (const entry of incoming) {
    const pageUrl = cleanText(entry?.pageUrl, 500);
    const recipe = normalizeExtractedRecipe(entry?.parsed, pageUrl);
    if (!recipe) {
      refused += 1;
      continue;
    }
    if (findConstraintConflict(recipe, rules, matcher)) {
      filtered += 1;
      continue;
    }
    accepted.push(recipe);
  }

  const dish = cleanText(dishQuery, 200);
  let gated = accepted;
  if (dish) {
    const result = filterByDish(accepted, dish, { minimum: "partial" });
    gated = result.accepted.map((recipe) => ({
      ...recipe,
      // Anything that is not an exact/strong identity match is labelled, the
      // same way the dish pipeline labels its near matches.
      nearMatch: !["exact", "strong"].includes(recipe.dishMatch?.verdict),
    }));
    if (gated.length < accepted.length) {
      filtered += accepted.length - gated.length;
    }
    if (gated.length > 0) {
      warnings.push(
        warning(
          "UNSTRUCTURED_RECIPE",
          "Some recipes were extracted from page text rather than structured publisher data."
        )
      );
    }
  }

  if (refused > 0) {
    warnings.push(
      warning(
        "EXTRACTION_REJECTED",
        `${refused} extracted recipe${refused === 1 ? "" : "s"} could not be validated and were ignored.`
      )
    );
  }
  if (filtered > 0) {
    warnings.push(
      warning(
        "EXTRACTION_FILTERED",
        `${filtered} extracted recipe${filtered === 1 ? "" : "s"} were filtered by the user's saved constraints.`
      )
    );
  }

  const seen = new Set(current.map((recipe) => urlKey(recipe?.url)));
  const merged = [...current];
  for (const recipe of gated) {
    if (merged.length >= MAX_DISH_RESULT_COUNT) break;
    const key = urlKey(recipe?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(recipe);
  }

  return { recipes: merged, warnings };
}

/** Cheap sanity check used by tests and the route. */
export function isSameRecipeTitle(left, right) {
  return normalizeDishText(left) === normalizeDishText(right);
}
