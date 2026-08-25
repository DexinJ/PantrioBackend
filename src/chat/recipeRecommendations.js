import { fetchPublicTextPage } from "./safeWebFetch.js";
import { parseRecipeJsonLd } from "./recipeJsonLd.js";

const ENERGY_PREFERENCES = new Set(["any", "light", "balanced", "hearty"]);
const MAX_RESULT_COUNT = 6;
const DEFAULT_RESULT_COUNT = 5;
const DEFAULT_LIMITS = Object.freeze({
  maxSearchQueries: 2,
  searchResultsPerQuery: 6,
  maxPages: 8,
  fetchConcurrency: 3,
  pageTimeoutMs: 8_000,
  pageMaxBytes: 384 * 1024,
  overallTimeoutMs: 20_000,
  maxRecipesPerPage: 4,
});
const LIMIT_CEILINGS = Object.freeze({
  maxSearchQueries: 2,
  searchResultsPerQuery: 10,
  maxPages: 10,
  fetchConcurrency: 3,
  pageTimeoutMs: 12_000,
  pageMaxBytes: 512 * 1024,
  overallTimeoutMs: 30_000,
  maxRecipesPerPage: 6,
});

const TERM_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "fresh",
  "large",
  "medium",
  "small",
  "whole",
  "package",
  "pack",
  "container",
  "bottle",
  "bag",
  "carton",
]);

const ALLERGEN_GROUPS = Object.freeze({
  shellfish: [
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "crayfish",
    "crawfish",
    "scallop",
    "clam",
    "mussel",
    "oyster",
  ],
  peanut: ["peanut", "groundnut"],
  peanuts: ["peanut", "groundnut"],
  "tree nut": [
    "almond",
    "brazil nut",
    "cashew",
    "hazelnut",
    "macadamia",
    "pecan",
    "pistachio",
    "walnut",
  ],
  "tree nuts": [
    "almond",
    "brazil nut",
    "cashew",
    "hazelnut",
    "macadamia",
    "pecan",
    "pistachio",
    "walnut",
  ],
  nuts: [
    "peanut",
    "almond",
    "brazil nut",
    "cashew",
    "hazelnut",
    "macadamia",
    "pecan",
    "pistachio",
    "walnut",
  ],
  dairy: [
    "milk",
    "butter",
    "cheese",
    "cream",
    "yogurt",
    "yoghurt",
    "whey",
    "casein",
    "ghee",
  ],
  egg: ["egg", "mayonnaise", "meringue"],
  eggs: ["egg", "mayonnaise", "meringue"],
  gluten: [
    "wheat",
    "barley",
    "rye",
    "spelt",
    "farro",
    "semolina",
    "couscous",
    "flour",
  ],
  wheat: ["wheat", "spelt", "farro", "semolina", "couscous", "flour"],
  soy: ["soy", "soya", "tofu", "tempeh", "edamame", "miso"],
  sesame: ["sesame", "tahini"],
  fish: [
    "fish",
    "salmon",
    "tuna",
    "cod",
    "tilapia",
    "anchovy",
    "sardine",
    "trout",
    "halibut",
  ],
});

const MEAT_TERMS = [
  "beef",
  "pork",
  "chicken",
  "turkey",
  "lamb",
  "veal",
  "bacon",
  "ham",
  "sausage",
  "prosciutto",
  "gelatin",
];
const FISH_TERMS = [...ALLERGEN_GROUPS.fish, ...ALLERGEN_GROUPS.shellfish];
const ANIMAL_PRODUCT_TERMS = [
  ...MEAT_TERMS,
  ...FISH_TERMS,
  ...ALLERGEN_GROUPS.dairy,
  ...ALLERGEN_GROUPS.egg,
  "honey",
];
const DIET_EXCLUSIONS = Object.freeze({
  vegan: ANIMAL_PRODUCT_TERMS,
  vegetarian: [...MEAT_TERMS, ...FISH_TERMS],
  pescatarian: MEAT_TERMS,
  "dairy free": ALLERGEN_GROUPS.dairy,
  "gluten free": ALLERGEN_GROUPS.gluten,
});

const CUISINE_GROUPS = Object.freeze({
  asian: [
    "asian",
    "chinese",
    "japanese",
    "korean",
    "thai",
    "vietnamese",
    "filipino",
    "indonesian",
    "malaysian",
    "indian",
    "south asian",
  ],
  american: [
    "american",
    "cajun",
    "creole",
    "southern",
    "tex mex",
    "hawaiian",
  ],
  mediterranean: [
    "mediterranean",
    "greek",
    "italian",
    "spanish",
    "levantine",
    "turkish",
  ],
  latin: [
    "latin",
    "mexican",
    "brazilian",
    "peruvian",
    "colombian",
    "caribbean",
  ],
});

const PANTRY_STAPLES = new Set([
  "water",
  "salt",
  "pepper",
  "black pepper",
  "oil",
  "olive oil",
  "cooking spray",
]);

export class RecipeRecommendationError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "RecipeRecommendationError";
    this.code = code;
  }
}

function warning(code, message) {
  return { code, message };
}

function pushWarning(warnings, entry) {
  if (!warnings.some(({ code }) => code === entry.code)) warnings.push(entry);
}

function clip(value, maxLength = 80) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function normalizeText(value) {
  return clip(String(value || ""), 400)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeToken(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -2);
  if (
    token.length > 3 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function termTokens(value, { removeStopWords = false } = {}) {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !removeStopWords || !TERM_STOP_WORDS.has(token))
    .map(singularizeToken);
}

function termMatchesIngredient(term, ingredient) {
  const expected = termTokens(term, { removeStopWords: true });
  if (expected.length === 0) return false;
  const actual = new Set(termTokens(ingredient));
  return expected.every((token) => actual.has(token));
}

function normalizedStringList(value, { maxItems = 20, maxLength = 60 } = {}) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const entry of value) {
    const text = clip(typeof entry === "string" ? entry : entry?.name, maxLength);
    if (!text) continue;
    if (!output.some((existing) => normalizeText(existing) === normalizeText(text))) {
      output.push(text);
    }
    if (output.length >= maxItems) break;
  }
  return output;
}

function boundedInteger(value, { min, max }) {
  if (!Number.isFinite(value)) return null;
  const integer = Math.round(value);
  return integer >= min && integer <= max ? integer : null;
}

function normalizeLimit(value, key, min) {
  const proposed = boundedInteger(value, {
    min,
    max: LIMIT_CEILINGS[key],
  });
  return proposed ?? DEFAULT_LIMITS[key];
}

function normalizeLimits(limits = {}) {
  return {
    maxSearchQueries: normalizeLimit(limits.maxSearchQueries, "maxSearchQueries", 1),
    searchResultsPerQuery: normalizeLimit(
      limits.searchResultsPerQuery,
      "searchResultsPerQuery",
      1
    ),
    maxPages: normalizeLimit(limits.maxPages, "maxPages", 1),
    fetchConcurrency: normalizeLimit(limits.fetchConcurrency, "fetchConcurrency", 1),
    pageTimeoutMs: normalizeLimit(limits.pageTimeoutMs, "pageTimeoutMs", 100),
    pageMaxBytes: normalizeLimit(limits.pageMaxBytes, "pageMaxBytes", 16 * 1024),
    overallTimeoutMs: normalizeLimit(
      limits.overallTimeoutMs,
      "overallTimeoutMs",
      100
    ),
    maxRecipesPerPage: normalizeLimit(
      limits.maxRecipesPerPage,
      "maxRecipesPerPage",
      1
    ),
  };
}

function explicitPreferences(recipeContext) {
  const container = preferenceContainer(recipeContext);
  return container?.explicit && typeof container.explicit === "object"
    ? container.explicit
    : container;
}

function preferenceContainer(recipeContext) {
  return (
    recipeContext?.preferences ??
    recipeContext?.savedPreferences ??
    recipeContext?.recipePreferences ??
    {}
  );
}

function learnedPreferences(recipeContext) {
  const container = preferenceContainer(recipeContext);
  return container?.learned && typeof container.learned === "object"
    ? container.learned
    : {};
}

function normalizeInventory(recipeContext) {
  return normalizedStringList(
    recipeContext?.inventory ?? recipeContext?.fridgeItems ?? [],
    { maxItems: 80, maxLength: 100 }
  );
}

function normalizeEnergy(value) {
  const normalized = normalizeText(value).replace(/ /g, "_");
  const aliases = {
    low_calorie: "light",
    healthy: "light",
    filling: "hearty",
    comfort: "hearty",
    none: "any",
  };
  const resolved = aliases[normalized] || normalized;
  return ENERGY_PREFERENCES.has(resolved) ? resolved : null;
}

function normalizeInputs(overrides = {}, recipeContext = {}) {
  const saved = explicitPreferences(recipeContext);
  const learned = learnedPreferences(recipeContext);
  const personalizationEnabled =
    preferenceContainer(recipeContext)?.personalization?.enabled !== false;
  const requestedCuisines = normalizedStringList(
    overrides?.cuisines ?? overrides?.preferredCuisines,
    { maxItems: 5, maxLength: 40 }
  );
  const savedCuisines = personalizationEnabled
    ? normalizedStringList(saved?.preferredCuisines, {
        maxItems: 10,
        maxLength: 40,
      })
    : [];
  const energyPreference =
    normalizeEnergy(overrides?.energyPreference) ??
    (personalizationEnabled
      ? normalizeEnergy(saved?.preferredEnergy ?? saved?.preferredEnergyLevel)
      : null) ??
    "any";
  const requestedCalories = boundedInteger(overrides?.maxCaloriesPerServing, {
    min: 100,
    max: 2_500,
  });
  const savedCalories = personalizationEnabled
    ? boundedInteger(saved?.maxCaloriesPerServing, {
        min: 100,
        max: 2_500,
      })
    : null;
  const requestedMinutes = boundedInteger(overrides?.maxPrepMinutes, {
    min: 5,
    max: 480,
  });
  const savedMinutes = personalizationEnabled
    ? boundedInteger(saved?.maxPrepMinutes, {
        min: 5,
        max: 480,
      })
    : null;
  const requestedCount = boundedInteger(overrides?.resultCount, {
    min: 1,
    max: MAX_RESULT_COUNT,
  });

  const selectedIngredients = normalizedStringList(
    recipeContext?.selectedIngredients,
    { maxItems: 30, maxLength: 100 }
  );
  const mustUseIngredients = normalizedStringList(overrides?.mustUseIngredients, {
    maxItems: 20,
    maxLength: 100,
  });
  const requestedIngredients = normalizedStringList(
    [...selectedIngredients, ...mustUseIngredients],
    { maxItems: 40, maxLength: 100 }
  );
  const inventory = normalizedStringList(
    [...selectedIngredients, ...normalizeInventory(recipeContext)],
    { maxItems: 80, maxLength: 100 }
  );

  return {
    inventory,
    selectedIngredients,
    mustUseIngredients,
    requestedIngredients,
    requestedCuisines,
    savedCuisines,
    dislikedCuisines: personalizationEnabled
      ? normalizedStringList(saved?.dislikedCuisines, {
          maxItems: 10,
          maxLength: 40,
        })
      : [],
    energyPreference,
    maxCaloriesPerServing: requestedCalories ?? savedCalories,
    maxPrepMinutes: requestedMinutes ?? savedMinutes,
    mealType: clip(overrides?.mealType, 40),
    servings:
      boundedInteger(overrides?.servings, { min: 1, max: 12 }) ??
      (personalizationEnabled
        ? boundedInteger(saved?.defaultServings, { min: 1, max: 12 })
        : null),
    resultCount: requestedCount ?? DEFAULT_RESULT_COUNT,
    allergens: normalizedStringList(saved?.allergens, {
      maxItems: 20,
      maxLength: 60,
    }),
    excludedIngredients: [
      ...normalizedStringList(saved?.excludedIngredients, {
        maxItems: 30,
        maxLength: 60,
      }),
      ...normalizedStringList(overrides?.excludedIngredients, {
        maxItems: 20,
        maxLength: 60,
      }),
    ],
    dislikedIngredients: personalizationEnabled
      ? normalizedStringList(saved?.dislikedIngredients, {
          maxItems: 30,
          maxLength: 60,
        })
      : [],
    dietaryPatterns: [
      ...normalizedStringList(saved?.dietaryPatterns, {
        maxItems: 10,
        maxLength: 40,
      }),
      ...normalizedStringList(overrides?.dietaryPatterns, {
        maxItems: 5,
        maxLength: 40,
      }),
    ],
    learnedCuisineScores:
      personalizationEnabled &&
      learned?.cuisineScores &&
      typeof learned.cuisineScores === "object"
        ? learned.cuisineScores
        : {},
    personalizationEnabled,
  };
}

function createConstraintRules(inputs, warnings) {
  const rules = [];
  const addRule = (label, terms) => {
    const normalizedTerms = normalizedStringList(terms, {
      maxItems: 60,
      maxLength: 60,
    });
    if (normalizedTerms.length > 0) rules.push({ label, terms: normalizedTerms });
  };

  for (const allergen of inputs.allergens) {
    const key = normalizeText(allergen)
      .replace(/\b(?:allergy|allergies)\b/g, "")
      .trim();
    addRule(allergen, ALLERGEN_GROUPS[key] || [allergen]);
  }
  for (const excluded of inputs.excludedIngredients) {
    const key = normalizeText(excluded);
    addRule(excluded, ALLERGEN_GROUPS[key] || [excluded]);
  }
  for (const pattern of inputs.dietaryPatterns) {
    const key = normalizeText(pattern).replace(/\b(diet|food)\b/g, "").trim();
    const terms = DIET_EXCLUSIONS[key];
    if (terms) {
      addRule(`diet:${pattern}`, terms);
    } else {
      pushWarning(
        warnings,
        warning(
          "DIETARY_PATTERN_NOT_VERIFIED",
          `The '${clip(pattern, 40)}' dietary pattern could not be verified reliably from publisher data.`
        )
      );
    }
  }

  if (inputs.allergens.length > 0) {
    pushWarning(
      warnings,
      warning(
        "ALLERGEN_CROSS_CONTACT_NOT_VERIFIED",
        "Ingredient lists were checked, but publisher pages cannot verify cross-contact or facility handling."
      )
    );
  }
  return rules;
}

function buildSearchQueries(inputs, limits) {
  const preferenceParts = [];
  const cuisines = inputs.requestedCuisines.length
    ? inputs.requestedCuisines
    : inputs.savedCuisines;
  if (cuisines.length) preferenceParts.push(cuisines.slice(0, 2).join(" or "));
  if (inputs.energyPreference === "light") preferenceParts.push("light low calorie");
  if (inputs.energyPreference === "hearty") preferenceParts.push("hearty filling");
  if (inputs.energyPreference === "balanced") preferenceParts.push("balanced");
  if (inputs.mealType) preferenceParts.push(inputs.mealType);
  if (inputs.maxCaloriesPerServing != null) {
    preferenceParts.push(`under ${inputs.maxCaloriesPerServing} calories per serving`);
  }
  if (inputs.maxPrepMinutes != null) {
    preferenceParts.push(`under ${inputs.maxPrepMinutes} minutes`);
  }
  if (inputs.servings != null) preferenceParts.push(`${inputs.servings} servings`);

  const requestedIngredients = inputs.requestedIngredients.slice(0, 8);
  const requestedKeys = new Set(requestedIngredients.map(normalizeText));
  const inventory = inputs.inventory
    .filter((item) => !requestedKeys.has(normalizeText(item)))
    .slice(0, 8);
  const primary = clip(
    [
      requestedIngredients.length
        ? `using ${requestedIngredients.join(" ")}`
        : "",
      ...preferenceParts,
      inventory.length
        ? `${requestedIngredients.length ? "with" : "using"} ${inventory
            .slice(0, 5)
            .join(" ")}`
        : "",
      "recipe nutrition ingredients",
    ]
      .filter(Boolean)
      .join(" "),
    300
  );
  const secondary = clip(
    [
      "recipe",
      requestedIngredients.length
        ? `featuring ${requestedIngredients.join(" ")}`
        : "",
      inventory.length
        ? `with ${inventory.slice(0, 8).join(" ")}`
        : "easy meal ideas",
      cuisines.slice(0, 2).join(" "),
      inputs.energyPreference !== "any" ? inputs.energyPreference : "",
      "calories total time",
    ]
      .filter(Boolean)
      .join(" "),
    300
  );
  return [...new Set([primary, secondary].filter(Boolean))].slice(
    0,
    limits.maxSearchQueries
  );
}

function createLinkedDeadline(parentSignal, timeoutMs) {
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
    controller.abort(new Error("Recipe recommendation timed out."));
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

function abortError(deadline) {
  return new RecipeRecommendationError(
    deadline.timedOut ? "TIMEOUT" : "ABORTED",
    deadline.timedOut
      ? "Recipe recommendation timed out."
      : "Recipe recommendation was cancelled.",
    { cause: deadline.signal.reason }
  );
}

function assertNotAborted(deadline) {
  if (deadline.signal.aborted) throw abortError(deadline);
}

async function awaitAbortable(operation, deadline) {
  assertNotAborted(deadline);
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortError(deadline));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
  }
}

function normalizedSearchResults(value) {
  const source = Array.isArray(value) ? value : value?.results;
  if (!Array.isArray(source)) return [];
  const results = [];
  for (const entry of source) {
    const rawUrl = clip(entry?.link ?? entry?.url, 2_000);
    try {
      const url = new URL(rawUrl);
      if (
        !new Set(["http:", "https:"]).has(url.protocol) ||
        url.username ||
        url.password
      ) {
        continue;
      }
      url.hash = "";
      results.push({
        title: clip(entry?.title, 180),
        link: url.href,
        snippet: clip(entry?.snippet, 400),
      });
    } catch {
      // Ignore malformed search result URLs. The safe fetcher performs the
      // authoritative public-address validation before any production fetch.
    }
  }
  return results;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href.toLowerCase();
  } catch {
    return normalizeText(value);
  }
}

async function searchForPages(search, queries, limits, deadline, warnings) {
  const unique = new Map();
  let failedSearches = 0;
  for (const query of queries) {
    assertNotAborted(deadline);
    try {
      const response = await awaitAbortable(
        () =>
          search(
            { query, k: limits.searchResultsPerQuery },
            { signal: deadline.signal }
          ),
        deadline
      );
      if (response?.error) failedSearches += 1;
      for (const result of normalizedSearchResults(response).slice(
        0,
        limits.searchResultsPerQuery
      )) {
        const key = canonicalUrl(result.link);
        if (!unique.has(key)) unique.set(key, result);
        if (unique.size >= limits.maxPages) break;
      }
    } catch (error) {
      if (deadline.signal.aborted) throw abortError(deadline);
      failedSearches += 1;
    }
    if (unique.size >= limits.maxPages) break;
  }
  if (failedSearches > 0) {
    pushWarning(
      warnings,
      warning(
        "SEARCH_PARTIALLY_UNAVAILABLE",
        "One or more recipe searches were unavailable; recommendations may be limited."
      )
    );
  }
  return [...unique.values()].slice(0, limits.maxPages);
}

async function fetchRecipePages(fetchPage, pages, limits, deadline) {
  const fetched = new Array(pages.length);
  let cursor = 0;
  let failedPages = 0;
  let truncatedPages = 0;
  let malformedScripts = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= pages.length) return;
      assertNotAborted(deadline);
      const result = pages[index];
      try {
        const page = await awaitAbortable(
          () =>
            fetchPage(result.link, {
              signal: deadline.signal,
              timeoutMs: limits.pageTimeoutMs,
              maxBytes: limits.pageMaxBytes,
              maxRedirects: 3,
            }),
          deadline
        );
        if (typeof page?.text !== "string") {
          failedPages += 1;
          continue;
        }
        if (page.truncated) truncatedPages += 1;
        const parsed = parseRecipeJsonLd(page.text, {
          pageUrl: page.url || result.link,
          maxRecipes: limits.maxRecipesPerPage,
        });
        malformedScripts += parsed.diagnostics.malformedScripts;
        fetched[index] = parsed.recipes;
      } catch (error) {
        if (deadline.signal.aborted) throw abortError(deadline);
        failedPages += 1;
      }
    }
  }

  const workerCount = Math.min(limits.fetchConcurrency, pages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    recipes: fetched.flatMap((entries) => entries || []),
    failedPages,
    truncatedPages,
    malformedScripts,
    fetchedPages: fetched.filter(Boolean).length,
  };
}

function findConstraintConflict(recipe, rules) {
  for (const rule of rules) {
    for (const ingredient of recipe.ingredients) {
      if (rule.terms.some((term) => termMatchesIngredient(term, ingredient))) {
        return { label: rule.label, ingredient };
      }
    }
  }
  return null;
}

function applyHardConstraints(
  recipes,
  inputs,
  rules,
  { keepUnknownWhenEstimated = false } = {}
) {
  const stats = {
    excludedIngredient: 0,
    overCalorieLimit: 0,
    caloriesUnknown: 0,
    overTimeLimit: 0,
    timeUnknown: 0,
  };
  if (keepUnknownWhenEstimated) {
    stats.caloriesUnknownSoft = 0;
    stats.timeUnknownSoft = 0;
  }
  const accepted = [];
  for (const recipe of recipes) {
    if (findConstraintConflict(recipe, rules)) {
      stats.excludedIngredient += 1;
      continue;
    }
    if (inputs.maxCaloriesPerServing != null) {
      if (recipe.caloriesPerServing == null) {
        if (keepUnknownWhenEstimated) {
          stats.caloriesUnknownSoft += 1;
        } else {
          stats.caloriesUnknown += 1;
          continue;
        }
      } else if (recipe.caloriesPerServing > inputs.maxCaloriesPerServing) {
        stats.overCalorieLimit += 1;
        continue;
      }
    }
    // maxPrepMinutes is the public contract's total-time ceiling. As with an
    // explicit calorie cap, unverified timing cannot be claimed to fit. When
    // AI estimation is active, recipes that could not be estimated are kept
    // with a soft penalty and warnings instead of being dropped.
    if (inputs.maxPrepMinutes != null) {
      if (recipe.totalMinutes == null) {
        if (keepUnknownWhenEstimated) {
          stats.timeUnknownSoft += 1;
        } else {
          stats.timeUnknown += 1;
          continue;
        }
      } else if (recipe.totalMinutes > inputs.maxPrepMinutes) {
        stats.overTimeLimit += 1;
        continue;
      }
    }
    accepted.push(recipe);
  }
  return { recipes: accepted, stats };
}

function candidateCuisineText(recipe) {
  return [recipe.title, ...recipe.cuisines].map(normalizeText).join(" ");
}

function cuisineMatches(preference, recipe) {
  const normalizedPreference = normalizeText(preference);
  if (!normalizedPreference) return false;
  const candidates = candidateCuisineText(recipe);
  const group = CUISINE_GROUPS[normalizedPreference] || [normalizedPreference];
  return group.some((entry) => {
    const words = termTokens(entry);
    const haystack = new Set(termTokens(candidates));
    return words.length > 0 && words.every((word) => haystack.has(word));
  });
}

function cuisineScore(recipe, inputs) {
  const requested = inputs.requestedCuisines;
  const saved = inputs.savedCuisines;
  let score = requested.length
    ? requested.some((entry) => cuisineMatches(entry, recipe))
      ? 1
      : 0.1
    : saved.length
      ? saved.some((entry) => cuisineMatches(entry, recipe))
        ? 0.9
        : 0.3
      : 0.5;

  if (inputs.dislikedCuisines.some((entry) => cuisineMatches(entry, recipe))) {
    score = Math.min(score, 0.05);
  }
  for (const [cuisine, rawValue] of Object.entries(inputs.learnedCuisineScores)) {
    if (!cuisineMatches(cuisine, recipe) || !Number.isFinite(rawValue)) continue;
    score += Math.max(-0.1, Math.min(0.1, rawValue * 0.05));
  }
  return Math.max(0, Math.min(1, score));
}

function energyScore(recipe, energyPreference) {
  const calories = recipe.caloriesPerServing;
  if (energyPreference === "any") return 0.5;
  if (calories == null) return 0.25;
  if (energyPreference === "light") {
    if (calories <= 350) return 1;
    if (calories <= 500) return 0.75;
    if (calories <= 650) return 0.35;
    return 0.05;
  }
  if (energyPreference === "hearty") {
    if (calories >= 650) return 1;
    if (calories >= 500) return 0.75;
    if (calories >= 350) return 0.4;
    return 0.15;
  }
  if (calories >= 350 && calories <= 650) return 1;
  if (calories >= 250 && calories <= 800) return 0.6;
  return 0.2;
}

function matchItemsToRecipe(recipe, items) {
  const matched = [];
  const matchedIngredientIndexes = new Set();
  for (const item of items) {
    const index = recipe.ingredients.findIndex((ingredient) =>
      termMatchesIngredient(item, ingredient)
    );
    if (index >= 0) {
      matched.push(item);
      matchedIngredientIndexes.add(index);
    }
  }
  return { matched, matchedIngredientIndexes };
}

function ingredientMatches(recipe, inputs) {
  const inventoryMatch = matchItemsToRecipe(recipe, inputs.inventory);
  const used = [];
  used.push(...inventoryMatch.matched);
  const relevantIngredients = recipe.ingredients.filter(
    (ingredient) =>
      ![...PANTRY_STAPLES].some((staple) => termMatchesIngredient(staple, ingredient))
  );
  const denominator = Math.max(1, Math.min(10, relevantIngredients.length));
  const requestedMatch = matchItemsToRecipe(recipe, inputs.requestedIngredients);
  const selectedMatch = matchItemsToRecipe(recipe, inputs.selectedIngredients);
  const mustUseMatch = matchItemsToRecipe(recipe, inputs.mustUseIngredients);
  const selectedCoverage = inputs.selectedIngredients.length
    ? selectedMatch.matched.length / inputs.selectedIngredients.length
    : null;
  const mustUseCoverage = inputs.mustUseIngredients.length
    ? mustUseMatch.matched.length / inputs.mustUseIngredients.length
    : null;
  const requestedScore =
    mustUseCoverage != null && selectedCoverage != null
      ? mustUseCoverage * 0.7 + selectedCoverage * 0.3
      : mustUseCoverage ?? selectedCoverage ?? 0.5;
  return {
    usedIngredients: used.slice(0, 20),
    missingIngredients: recipe.ingredients
      .filter(
        (_ingredient, index) => !inventoryMatch.matchedIngredientIndexes.has(index)
      )
      .slice(0, 30),
    score: Math.min(1, used.length / denominator),
    requestedScore,
    matchedRequestedIngredients: requestedMatch.matched.slice(0, 40),
    unmatchedRequestedIngredients: inputs.requestedIngredients
      .filter(
        (item) =>
          !requestedMatch.matched.some(
            (matched) => normalizeText(matched) === normalizeText(item)
          )
      )
      .slice(0, 40),
  };
}

function dislikedIngredientPenalty(recipe, inputs) {
  const matched = matchItemsToRecipe(recipe, inputs.dislikedIngredients).matched;
  return {
    matchedDislikedIngredients: matched.slice(0, 30),
    // Dislikes are a preference, never a safety constraint. Multiple matches
    // increase the penalty, but the cap keeps an otherwise strong recipe viable.
    dislikedIngredientPenalty: Math.min(0.18, matched.length * 0.06),
  };
}

function timeScore(recipe, maxPrepMinutes) {
  if (maxPrepMinutes == null) return 0.5;
  if (recipe.totalMinutes == null) return 0.25;
  if (recipe.totalMinutes <= maxPrepMinutes) return 1;
  return Math.max(0.05, maxPrepMinutes / recipe.totalMinutes);
}

function qualityScore(recipe) {
  return (
    0.3 +
    (recipe.instructions.length > 0 ? 0.25 : 0) +
    (recipe.caloriesPerServing != null ? 0.2 : 0) +
    (recipe.totalMinutes != null ? 0.15 : 0) +
    (recipe.cuisines.length > 0 ? 0.1 : 0)
  );
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function buildWhyRecommended(
  recipe,
  inputs,
  usedIngredients,
  matchedRequestedIngredients
) {
  const reasons = [];
  if (matchedRequestedIngredients.length > 0) {
    reasons.push(
      `Uses ${matchedRequestedIngredients.slice(0, 3).join(", ")} as requested`
    );
  }
  const matchedCuisine = [
    ...inputs.requestedCuisines,
    ...inputs.savedCuisines,
  ].find((cuisine) => cuisineMatches(cuisine, recipe));
  if (matchedCuisine) reasons.push(`Matches your ${matchedCuisine} preference`);
  if (usedIngredients.length > 0) {
    reasons.push(
      `uses ${usedIngredients.length} ingredient${usedIngredients.length === 1 ? "" : "s"} from your fridge`
    );
  }
  if (inputs.energyPreference === "light" && recipe.caloriesPerServing != null) {
    reasons.push("fits a lighter meal");
  }
  if (
    inputs.maxPrepMinutes != null &&
    recipe.totalMinutes != null &&
    recipe.totalMinutes <= inputs.maxPrepMinutes
  ) {
    reasons.push(`is ready within ${inputs.maxPrepMinutes} minutes`);
  }
  if (reasons.length === 0) reasons.push("Has complete publisher recipe data");
  const sentence = reasons.slice(0, 3).join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

function scoreCandidates(recipes, inputs) {
  return recipes.map((recipe, index) => {
    const ingredients = ingredientMatches(recipe, inputs);
    const dislikes = dislikedIngredientPenalty(recipe, inputs);
    const breakdown = {
      cuisine: cuisineScore(recipe, inputs),
      energy: energyScore(recipe, inputs.energyPreference),
      ingredients: ingredients.score,
      requestedIngredients: ingredients.requestedScore,
      time: timeScore(recipe, inputs.maxPrepMinutes),
      quality: qualityScore(recipe),
      dislikedIngredientPenalty: dislikes.dislikedIngredientPenalty,
    };
    const baseScore = inputs.requestedIngredients.length
      ? breakdown.cuisine * 0.18 +
        breakdown.energy * 0.1 +
        breakdown.ingredients * 0.17 +
        breakdown.requestedIngredients * 0.35 +
        breakdown.time * 0.1 +
        breakdown.quality * 0.1
      : breakdown.cuisine * 0.28 +
        breakdown.energy * 0.15 +
        breakdown.ingredients * 0.32 +
        breakdown.time * 0.15 +
        breakdown.quality * 0.1;
    const score = Math.max(0, baseScore - dislikes.dislikedIngredientPenalty);
    return {
      ...recipe,
      ...ingredients,
      ...dislikes,
      score: rounded(score),
      scoreBreakdown: Object.fromEntries(
        Object.entries(breakdown).map(([key, value]) => [key, rounded(value)])
      ),
      whyRecommended: buildWhyRecommended(
        recipe,
        inputs,
        ingredients.usedIngredients,
        ingredients.matchedRequestedIngredients
      ),
      _index: index,
    };
  });
}

function recipeCompleteness(recipe) {
  return (
    recipe.ingredients.length +
    recipe.instructions.length * 2 +
    (recipe.caloriesPerServing == null ? 0 : 4) +
    (recipe.totalMinutes == null ? 0 : 2)
  );
}

function dedupeCandidates(candidates) {
  const byUrl = new Map();
  const byDomainAndTitle = new Map();
  for (const recipe of candidates) {
    const urlKey = canonicalUrl(recipe.url);
    let domain = "";
    try {
      domain = new URL(recipe.url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      domain = normalizeText(recipe.source);
    }
    const titleKey = `${domain}|${normalizeText(recipe.title)}`;
    const existing = byUrl.get(urlKey) || byDomainAndTitle.get(titleKey);
    if (!existing || recipeCompleteness(recipe) > recipeCompleteness(existing)) {
      if (existing) {
        byUrl.delete(canonicalUrl(existing.url));
        let existingDomain = "";
        try {
          existingDomain = new URL(existing.url).hostname
            .replace(/^www\./i, "")
            .toLowerCase();
        } catch {
          existingDomain = normalizeText(existing.source);
        }
        byDomainAndTitle.delete(`${existingDomain}|${normalizeText(existing.title)}`);
      }
      byUrl.set(urlKey, recipe);
      byDomainAndTitle.set(titleKey, recipe);
    }
  }
  return [...byUrl.values()];
}

function recipeDomain(recipe) {
  try {
    return new URL(recipe.url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return normalizeText(recipe.source);
  }
}

function primaryCuisine(recipe) {
  return normalizeText(recipe.cuisines[0] || "unknown");
}

function selectDiverse(candidates, count) {
  const remaining = [...candidates];
  const selected = [];
  const domains = new Map();
  const cuisines = new Map();
  while (remaining.length > 0 && selected.length < count) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const recipe = remaining[index];
      const domainCount = domains.get(recipeDomain(recipe)) || 0;
      const cuisineCount = cuisines.get(primaryCuisine(recipe)) || 0;
      const adjusted = recipe.score - domainCount * 0.1 - cuisineCount * 0.035;
      if (
        adjusted > bestAdjusted ||
        (adjusted === bestAdjusted && recipe._index < remaining[bestIndex]._index)
      ) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    domains.set(recipeDomain(chosen), (domains.get(recipeDomain(chosen)) || 0) + 1);
    cuisines.set(
      primaryCuisine(chosen),
      (cuisines.get(primaryCuisine(chosen)) || 0) + 1
    );
  }
  return selected;
}

function publicRecipe(recipe) {
  const { _index, ...output } = recipe;
  return {
    ...output,
    ingredients: output.ingredients.slice(0, 30),
    instructions: output.instructions.slice(0, 12).map((step) => clip(step, 300)),
    usedIngredients: output.usedIngredients.slice(0, 20),
    missingIngredients: output.missingIngredients.slice(0, 30),
    matchedRequestedIngredients: output.matchedRequestedIngredients.slice(0, 40),
    unmatchedRequestedIngredients: output.unmatchedRequestedIngredients.slice(0, 40),
    matchedDislikedIngredients: output.matchedDislikedIngredients.slice(0, 30),
    warnings: output.warnings.slice(0, 8),
  };
}

/**
 * Finds and ranks published recipes using model-extracted current-turn
 * overrides plus trusted inventory and saved preferences.
 *
 * `deps.search` intentionally matches the existing TOOLS.webSearch signature:
 *   search({ query, k }, { signal }) -> { results: [{ title, link, snippet }] }
 * `deps.estimateMeta` is an optional best-effort metadata estimator for
 * recipes the publisher left without calories/time. It receives only recipes
 * with missing metadata, mutates them in place with "ai_estimated" confidence
 * labels, and returns `{ ok, estimatedCount, failedCount }`. Network and LLM
 * dependencies remain injectable for deterministic unit tests.
 */
export async function recommendRecipes(
  overrides = {},
  recipeContext = {},
  {
    search,
    fetchPage = fetchPublicTextPage,
    signal,
    limits: requestedLimits,
    estimateMeta,
    estimationEnabled = false,
  } = {}
) {
  if (typeof search !== "function") {
    throw new RecipeRecommendationError(
      "INVALID_DEPENDENCY",
      "A recipe search function is required."
    );
  }
  if (typeof fetchPage !== "function") {
    throw new RecipeRecommendationError(
      "INVALID_DEPENDENCY",
      "A safe webpage fetch function is required."
    );
  }

  const limits = normalizeLimits(requestedLimits);
  const inputs = normalizeInputs(overrides, recipeContext);
  const warnings = [];
  const constraintRules = createConstraintRules(inputs, warnings);
  const queries = buildSearchQueries(inputs, limits);
  const deadline = createLinkedDeadline(signal, limits.overallTimeoutMs);

  try {
    assertNotAborted(deadline);
    const pages = await searchForPages(search, queries, limits, deadline, warnings);
    const fetched = await fetchRecipePages(
      fetchPage,
      pages,
      limits,
      deadline
    );
    if (fetched.failedPages > 0) {
      pushWarning(
        warnings,
        warning(
          "PAGES_PARTIALLY_UNAVAILABLE",
          "One or more recipe pages could not be read safely."
        )
      );
    }
    if (fetched.truncatedPages > 0) {
      pushWarning(
        warnings,
        warning(
          "PAGES_TRUNCATED",
          "One or more large recipe pages were truncated before parsing."
        )
      );
    }
    if (fetched.malformedScripts > 0) {
      pushWarning(
        warnings,
        warning(
          "MALFORMED_PUBLISHER_DATA",
          "Some publisher recipe metadata was malformed and was skipped."
        )
      );
    }

    // Best-effort metadata estimation: fill missing calories/time with AI
    // estimates labeled as such, so hard caps filter on the estimate instead
    // of silently discarding every recipe with incomplete publisher data.
    const estimationActive =
      estimationEnabled && typeof estimateMeta === "function";
    let estimatedCount = 0;
    let estimationFailedCount = 0;
    if (estimationActive) {
      const missingMetadata = fetched.recipes.filter(
        (recipe) =>
          recipe.caloriesPerServing == null || recipe.totalMinutes == null
      );
      if (missingMetadata.length > 0) {
        let estimation;
        try {
          estimation = await awaitAbortable(
            () =>
              Promise.resolve(
                estimateMeta(missingMetadata, { signal: deadline.signal })
              ),
            deadline
          );
        } catch (error) {
          if (deadline.signal.aborted) throw abortError(deadline);
          estimation = null;
        }
        estimatedCount =
          estimation && estimation.ok ? estimation.estimatedCount || 0 : 0;
        estimationFailedCount = Math.max(
          0,
          missingMetadata.length - estimatedCount
        );
        if (estimationFailedCount > 0) {
          pushWarning(
            warnings,
            warning(
              "METADATA_ESTIMATION_PARTIAL",
              "Some recipes could not be estimated; their calories or timing may be unverified."
            )
          );
        }
      }
    }

    const constrained = applyHardConstraints(
      fetched.recipes,
      inputs,
      constraintRules,
      { keepUnknownWhenEstimated: estimationActive }
    );
    const deduped = dedupeCandidates(scoreCandidates(constrained.recipes, inputs));
    const selected = selectDiverse(deduped, inputs.resultCount).map(publicRecipe);
    if (selected.length === 0) {
      pushWarning(
        warnings,
        warning(
          "NO_MATCHING_RECIPES",
          inputs.maxCaloriesPerServing != null ||
            inputs.maxPrepMinutes != null ||
            constraintRules.length > 0
            ? "No fetched recipes had enough verified data to satisfy every hard constraint."
            : "No structured recipes could be extracted from the fetched pages."
        )
      );
    }

    return {
      recipes: selected,
      warnings: warnings.slice(0, 12),
      meta: {
        queryCount: queries.length,
        pagesConsidered: pages.length,
        pagesFetched: fetched.fetchedPages,
        candidatesParsed: fetched.recipes.length,
        candidatesAfterHardConstraints: constrained.recipes.length,
        returnedCount: selected.length,
        estimatedCount,
        estimationFailedCount,
        filtered: constrained.stats,
        applied: {
          cuisines:
            inputs.requestedCuisines.length > 0
              ? inputs.requestedCuisines
              : inputs.savedCuisines,
          energyPreference: inputs.energyPreference,
          maxCaloriesPerServing: inputs.maxCaloriesPerServing,
          maxPrepMinutes: inputs.maxPrepMinutes,
          mealType: inputs.mealType || null,
          servings: inputs.servings ?? null,
          inventoryItemCount: inputs.inventory.length,
          selectedIngredients: inputs.selectedIngredients,
          mustUseIngredients: inputs.mustUseIngredients,
          requestedIngredients: inputs.requestedIngredients,
          dislikedIngredientCount: inputs.dislikedIngredients.length,
          hasHardIngredientConstraints: constraintRules.length > 0,
          personalizationEnabled: inputs.personalizationEnabled,
        },
      },
    };
  } finally {
    deadline.cleanup();
  }
}
