// src/chat/recipeDishSearch.js
//
// Dish-name recipe search.
//
// This module is additive: it does not modify recipeRecommendations.js,
// tools.js, recipeRequest.js or any other existing file. It reuses the
// exported primitives (Serper web search, safe page fetch, JSON-LD parsing)
// and returns the same public recipe shape the existing chat/recipe-card
// contract expects, so its output drops straight into the current UI.
//
// Why a separate pipeline:
// The existing recommendRecipes engine is driven by fridge inventory and
// ingredient tokens. When a user names a dish ("tomato egg stir fry",
// "番茄炒蛋") the dish itself is never represented, so the only constraint is
// "contains tomato and egg" -- which a shakshuka, an egg-salad sandwich and a
// stir-fry all satisfy equally. Reported symptom: naming a Chinese classic
// returns cucumber-and-egg salads.
//
// The gap is closed in two ways:
//   1. dishQuery is carried through as a first-class constraint and enforced
//      by a dish identity gate (see scoreDishMatch).
//   2. Queries, tokenization and matching are language aware, so a dish named
//      in the user's app language is searched for in that language.
//
// Two measured findings shape the search budget:
//   - Chinese dish queries return ~20% usable recipe pages (video/news
//     dominate) versus ~60% for English, so non-English requests get a larger
//     query budget.
//   - Every fetch spent on a video, social or news host is budget not spent on
//     a recipe, so those hosts are skipped before any page is fetched.
//
// Integration notes (not applied here):
//   - Add `dishQuery` to RECOMMEND_RECIPES_TOOL in src/chat/tools.js and to
//     the mirrored schema in fridge-manager/api/recipeAssistant.js.
//   - Pass `language` (from buildRecipeContext) and call searchRecipesByDish
//     from the recipe tool when dishQuery is present; otherwise keep calling
//     recommendRecipes unchanged. searchRecipesWithDish does this dispatch.

import { OPENAI_API_KEY, SERPER_API_KEY } from "../config/env.js";
import { fetchPublicTextPage } from "./safeWebFetch.js";
import { parseRecipeJsonLd } from "./recipeJsonLd.js";
import { dedupeSimilarDishes } from "./recipeDedup.js";
import { extractRecipesFromPage } from "./recipeTextExtract.js";
import { MODEL_RECIPE_TRANSLATION } from "../config/models.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_DISH_RESULT_COUNT = 4;
export const DEFAULT_DISH_RESULT_COUNT = 4;

export const DEFAULT_DISH_LIMITS = Object.freeze({
  maxSearchQueries: 4,
  searchResultsPerQuery: 10,
  maxPages: 20,
  fetchConcurrency: 3,
  pageTimeoutMs: 10_000,
  pageMaxBytes: 512 * 1024,
  overallTimeoutMs: 25_000,
  maxRecipesPerPage: 6,
});

/**
 * Hosts that essentially never carry Schema.org Recipe markup. Measured host
 * mix for `番茄炒蛋 做法`: 2 recipe / 4 video / 4 news. Skipping these before
 * the fetch turns 10 wasted page reads into 3, and keeps the page budget for
 * pages that can actually produce a recipe.
 *
 * Entries are bare hostnames matched by exact host or subdomain suffix.
 * Pass `deniedHosts: []` to disable, or your own list to replace it.
 */
export const DEFAULT_DENIED_HOST_PATTERNS = Object.freeze([
  // video
  "youtube.com",
  "youtu.be",
  "bilibili.com",
  "douyin.com",
  "tiktok.com",
  "vimeo.com",
  "dailymotion.com",
  // social
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "twitter.com",
  "x.com",
  "weibo.com",
  "xiaohongshu.com",
  "threads.net",
  // forums and Q&A
  "reddit.com",
  "quora.com",
  "zhihu.com",
  "douban.com",
  "ptt.cc",
  "dcard.tw",
  // news, government and general portals seen in Chinese results
  "hk01.com",
  "tvb.com",
  "gov.hk",
  "ltn.com.tw",
  "udn.com",
  "ettoday.net",
  "setn.com",
  "chinatimes.com",
  "now.com",
  "am730.com.hk",
  "bastillepost.com",
  "sohu.com",
  "163.com",
  "sina.com.cn",
]);

/**
 * Text queries have a much lower recipe-page yield than English ones, so the
 * query budget is language aware. Extra queries are cheap once the host filter
 * is in place because they do not turn into extra page fetches.
 */
export function defaultDishQueryBudget(language) {
  return normalizeRecipeLanguage(language) === "en" ? 4 : 6;
}

export function hostnameOf(value) {
  try {
    return new URL(String(value || ""))
      .hostname.replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

export function isDeniedHost(hostname, patterns = DEFAULT_DENIED_HOST_PATTERNS) {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  if (!host || !Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(host);
    const candidate = String(pattern || "").replace(/^www\./i, "").toLowerCase();
    return Boolean(candidate) && (host === candidate || host.endsWith(`.${candidate}`));
  });
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export const SUPPORTED_RECIPE_LANGUAGES = Object.freeze(["en", "zh"]);

// Serper accepts BCP-47-ish host language codes. These are best effort: the
// dominant signal is the script of the query itself, but hl/gl help when the
// dish name is romanized or language neutral.
const SERPER_LOCALES = Object.freeze({
  en: Object.freeze({ hl: "en", gl: "us" }),
  zh: Object.freeze({ hl: "zh-cn", gl: "cn" }),
});

/**
 * Bounds an app-supplied language tag. Mirrors the existing `language`
 * convention used by the chat routes: a short string, defaulting to "en".
 */
export function normalizeRecipeLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return "en";
  if (/^zh(\b|[-_])/.test(raw) || raw === "zh") return "zh";
  if (/^en(\b|[-_])/.test(raw) || raw === "en") return "en";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(raw) && raw.length <= 32
    ? raw
    : "en";
}

export function serperLocaleFor(language) {
  const normalized = normalizeRecipeLanguage(language);
  return SERPER_LOCALES[normalized] ?? { hl: normalized, gl: undefined };
}

/** Locale-aware spelling for the strings this module generates itself. */
const MESSAGES = Object.freeze({
  en: Object.freeze({
    usesRequested: (items) => `Uses ${items.join(", ")} as requested`,
    fridgeItems: (count) =>
      `uses ${count} ingredient${count === 1 ? "" : "s"} from your fridge`,
    matchesDish: (dish) => `is a published ${dish} recipe`,
    completeData: "Has complete publisher recipe data",
    noDish: (dish) => `No published recipe for ${dish} was found.`,
    partialPages: "One or more searches were unavailable; results may be limited.",
    noStructured: (dish) =>
      `Pages matching ${dish} were found, but none exposed structured recipe data.`,
  }),
  zh: Object.freeze({
    usesRequested: (items) => `使用了你要求的${items.join("、")}`,
    fridgeItems: (count) => `用上了冰箱里的 ${count} 种食材`,
    matchesDish: (dish) => `是一份已发布的${dish}食谱`,
    completeData: "有完整的发布者食谱数据",
    noDish: (dish) => `没有找到「${dish}」的已发布食谱。`,
    partialPages: "部分搜索不可用，结果可能不完整。",
    noStructured: (dish) =>
      `找到了与「${dish}」相关的页面，但都没有结构化食谱数据。`,
  }),
});

export function messagesFor(language) {
  return MESSAGES[normalizeRecipeLanguage(language)] ?? MESSAGES.en;
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

// Conversion is delegated: OpenCC-style tables do it exactly, and the language
// service does it without a dependency. What stays local is a *detector*, which
// only needs to recognise that a string is Traditional so it can be routed for
// conversion. Relying on the old conversion map here missed ordinary text such
// as 滑嫩且風味濃厚, so this set is deliberately separate and broader.
const TRADITIONAL_DETECTION_CHARACTERS = new Set(
  `風濃個這說時會來對開關們過發經長門問間樣點種體裏頭實現當還進沒麼幾電話語讀寫
   學數樂買賣錢銀鐵車馬鳥魚龜龍鳳雞豬鴨鵝蝦貝殼麵飯湯鮮鹹薑蔥蘿蔔黃紅綠藍紙
   線網灣臺產業業務員團隊圖書畫愛戀懷憶應該讓認識詞詩誰請謝讚談論議記訊設計備
   價億儀內兩冊準別動勝區醫單嚴嗎響頁頂順預領題顏願類飛館饅餃餅燒燙滷醃釀醬
   鹽節慶豐儉樸傳統習慣氣營營養熱纖維質鍋盤壺蓋爐凍漿條餛飩圓顆隻費貴輕
   錯誤護衛雙張錄視頻聲燈燭煙霧黴菌酵漬雞顆湯麵醬鹹蔥薑
   燉燜涼絲塊條鍋盤醃滷燙沖嚐鐘廚藝馬鈴鳥鴨鵝驢鱸魷貝蘭蓮筍豬魚蝦`
    .replace(/\s+/g, "")
);

export function looksTraditional(value) {
  for (const character of String(value ?? "")) {
    if (TRADITIONAL_DETECTION_CHARACTERS.has(character)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const CJK_RANGES =
  "\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af";
const CJK_CHARACTER = new RegExp(`[${CJK_RANGES}]`);
const NON_WORD_CHARACTERS = new RegExp(`[^a-z0-9${CJK_RANGES}]+`, "g");

// Words that describe the request rather than the dish. Method words
// (stir fry, salad, soup) are deliberately NOT stripped: for "tomato egg stir
// fry" the method is the whole point, and it is what separates the stir-fry
// from the salads that caused the original bug.
export const DISH_MODIFIER_WORDS = new Set([
  "recipe",
  "recipes",
  "easy",
  "quick",
  "simple",
  "best",
  "homemade",
  "authentic",
  "traditional",
  "classic",
  "dish",
  "dishes",
  "做法",
  "食谱",
  "家常",
  "简单",
  "正宗",
  "传统",
  "教程",
  "怎么",
  "如何",
]);

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

/** Lowercases and strips punctuation without dropping CJK. */
export function normalizeDishText(value) {
  return String(value ?? "")
    .slice(0, 400)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(NON_WORD_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CJK-aware token list. Latin runs are singularized; CJK runs contribute the
 * whole run plus character bigrams, so 番茄 still matches inside 大番茄 and
 * 番茄炒蛋 keeps its 番茄 component.
 */
export function dishTokens(value) {
  const tokens = [];
  for (const run of normalizeDishText(value).split(" ").filter(Boolean)) {
    if (!CJK_CHARACTER.test(run)) {
      if (/^\d+$/.test(run)) continue;
      tokens.push(singularizeToken(run));
      continue;
    }
    const characters = [...run];
    tokens.push(run);
    for (let index = 0; index < characters.length; index += 1) {
      if (!/^\d+$/.test(characters[index])) tokens.push(characters[index]);
      if (index + 1 < characters.length) {
        const bigram = characters[index] + characters[index + 1];
        if (!/^[\d]+$/.test(bigram)) tokens.push(bigram);
      }
    }
  }
  return [...new Set(tokens)];
}

export function dishTokenSet(value) {
  return new Set(dishTokens(value));
}

// ---------------------------------------------------------------------------
// Ingredient vocabulary
// ---------------------------------------------------------------------------

// Bounded bilingual vocabulary. This is deliberately not general-purpose
// segmentation: it covers the ingredients a fridge app actually sees, and it
// doubles as the false-positive guard below.
export const INGREDIENT_ALIASES = Object.freeze({
  // Both scripts are listed explicitly. Matching no longer folds Traditional
  // into Simplified (that is the language service's job), so the fast path has
  // to know the spellings it cares about directly.
  tomato: ["tomato", "tomatoes", "番茄", "西红柿", "西紅柿", "蕃茄"],
  ketchup: ["ketchup", "tomato sauce", "tomato paste", "番茄酱", "番茄醬", "茄汁"],
  egg: ["egg", "eggs", "鸡蛋", "雞蛋", "蛋"],
  cucumber: ["cucumber", "cucumbers", "黄瓜", "黃瓜", "青瓜"],
  scallion: ["scallion", "scallions", "green onion", "spring onion", "葱", "蔥", "小葱", "小蔥", "青葱", "青蔥"],
  garlic: ["garlic", "蒜", "大蒜"],
  ginger: ["ginger", "姜", "薑", "生姜"],
  onion: ["onion", "onions", "洋葱"],
  chicken: ["chicken", "鸡肉", "雞肉"],
  pork: ["pork", "猪肉", "豬肉"],
  beef: ["beef", "牛肉"],
  lamb: ["lamb", "mutton", "羊肉"],
  shrimp: ["shrimp", "prawn", "prawns", "虾", "蝦", "虾仁", "蝦仁"],
  fish: ["fish", "鱼", "魚"],
  tofu: ["tofu", "豆腐"],
  rice: ["rice", "米饭", "米飯", "米"],
  noodle: ["noodle", "noodles", "面", "麵", "面条", "麵條"],
  flour: ["flour", "面粉", "麵粉"],
  milk: ["milk", "牛奶"],
  butter: ["butter", "黄油", "黃油"],
  cheese: ["cheese", "芝士", "奶酪"],
  yogurt: ["yogurt", "yoghurt", "酸奶"],
  potato: ["potato", "potatoes", "土豆", "马铃薯", "馬鈴薯"],
  carrot: ["carrot", "carrots", "胡萝卜", "胡蘿蔔"],
  mushroom: ["mushroom", "mushrooms", "蘑菇", "香菇"],
  pepper: ["pepper", "peppers", "bell pepper", "青椒", "彩椒"],
  cabbage: ["cabbage", "卷心菜", "白菜"],
  spinach: ["spinach", "菠菜"],
  salt: ["salt", "盐", "鹽"],
  sugar: ["sugar", "糖"],
  vinegar: ["vinegar", "醋"],
  oil: ["oil", "油"],
});

const ALIAS_INDEX = (() => {
  const entries = [];
  for (const [key, aliases] of Object.entries(INGREDIENT_ALIASES)) {
    for (const alias of aliases) {
      entries.push({ key, alias, normalized: normalizeDishText(alias) });
    }
  }
  // Longest alias first so the most specific reading wins (番茄酱 before 番茄).
  entries.sort((left, right) => right.normalized.length - left.normalized.length);
  return entries;
})();

/** Expands a user-supplied ingredient/dish item into all known spellings. */
export function expandIngredient(value) {
  const normalized = normalizeDishText(value);
  if (!normalized) return [];
  for (const { key, normalized: alias } of ALIAS_INDEX) {
    if (alias === normalized) {
      return [...new Set(INGREDIENT_ALIASES[key])];
    }
  }
  return [normalized];
}

/**
 * Term -> every spelling of that term, from the built-in vocabulary plus any
 * variants supplied by the language service. The built-in table stays as a
 * free fast path; the service is what covers everything the table does not.
 */
export function buildIngredientVariants(items, expanded = {}) {
  const variants = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const term = String(item || "").trim();
    if (!term || variants.has(term)) continue;
    const extra = sameSpellings(expanded?.[term]);
    variants.set(
      term,
      [
        ...new Set(
          [term, ...expandIngredient(term), ...extra]
            .map((entry) => String(entry || "").trim())
            .filter(Boolean)
        ),
      ]
    );
  }
  return variants;
}

// The language service returns { same, notSame } per term; a plain array is
// still accepted so existing callers and stubs keep working.
function sameSpellings(entry) {
  const source = Array.isArray(entry)
    ? entry
    : Array.isArray(entry?.same)
      ? entry.same
      : Array.isArray(entry?.variants)
        ? entry.variants
        : [];
  return source
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

/**
 * Names that contain the item but are a different product ("beef broth" for
 * beef). Supplied by the language service, never hard-coded here.
 */
export function buildIngredientExclusions(items, expanded = {}) {
  const exclusions = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const term = String(item || "").trim();
    if (!term || exclusions.has(term)) continue;
    const entry = expanded?.[term];
    const notSame = Array.isArray(entry) ? [] : entry?.notSame;
    if (!Array.isArray(notSame)) continue;
    const cleaned = notSame
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (cleaned.length > 0) exclusions.set(term, cleaned);
  }
  return exclusions;
}

/**
 * Ingredient matcher backed by a variant table. Any known spelling of the term
 * satisfying the line counts as a match, so a fridge item named 鸡子 can match
 * an English page or a Traditional Chinese one.
 *
 * Names the language service flagged as a *different* product ("beef broth" for
 * beef) win over a match, so a derivative never counts as the base ingredient.
 */
export function createIngredientMatcher(variants, exclusions = new Map()) {
  return function matches(term, ingredientLine) {
    const excluded =
      (exclusions instanceof Map ? exclusions.get(term) : null) ?? [];
    if (
      excluded.some((spelling) =>
        ingredientMatchesTerm(spelling, ingredientLine)
      )
    ) {
      return false;
    }
    const spellings =
      (variants instanceof Map ? variants.get(term) : null) ?? [term];
    return spellings.some((spelling) =>
      ingredientMatchesTerm(spelling, ingredientLine)
    );
  };
}

/**
 * True when a published ingredient line satisfies a user term.
 *
 * Handles the two failure modes of the current matcher:
 *   - CJK has no whitespace, so 番茄 must match inside 大番茄 2顆.
 *   - Script variants must match across regions (鸡蛋 vs 雞蛋).
 *
 * The specificity guard prevents 番茄酱 (ketchup) from satisfying 番茄
 * (tomato): when a longer known alias is present in the line, it wins.
 */
export function ingredientMatchesTerm(term, ingredientLine) {
  const haystack = normalizeDishText(ingredientLine);
  if (!haystack) return false;

  const requested = expandIngredient(term);
  if (requested.length === 0) return false;

  const actual = new Set(dishTokens(ingredientLine));
  const matches = requested.some((alias) => {
    const expected = dishTokens(alias);
    return expected.length > 0 && expected.every((token) => actual.has(token));
  });
  if (!matches) return false;

  const termKey = canonicalIngredientKey(term);
  if (!termKey) return true;

  // ALIAS_INDEX is sorted longest-first, so this is the most specific reading
  // of the line. When that reading names a different ingredient (番茄酱 =
  // ketchup, not 番茄 = tomato) the line does not satisfy the request.
  const mostSpecific = ALIAS_INDEX.find(({ normalized }) =>
    aliasPresent(haystack, normalized)
  );
  return !mostSpecific || mostSpecific.key === termKey;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// CJK has no delimiters, so containment is the match. Latin aliases need word
// boundaries, otherwise "egg" would be reported inside "eggplant".
function aliasPresent(haystack, alias) {
  if (!alias) return false;
  if (CJK_CHARACTER.test(alias)) return haystack.includes(alias);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`).test(
    haystack
  );
}

function canonicalIngredientKey(value) {
  const normalized = normalizeDishText(value);
  if (!normalized) return null;
  for (const entry of ALIAS_INDEX) {
    if (entry.normalized === normalized) return entry.key;
  }
  // A bare alias may still be a prefix of a known alias, e.g. "番茄".
  for (const entry of ALIAS_INDEX) {
    if (entry.normalized.startsWith(normalized)) return entry.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dish identity gate
// ---------------------------------------------------------------------------

export const DISH_VERDICTS = Object.freeze({
  exact: 3,
  strong: 2,
  partial: 1,
  none: 0,
});

/**
 * Removes request scaffolding ("recipe", "easy", "做法", "家常"...) from the
 * dish string before tokenizing. Stripping whole words upfront matters for
 * CJK: filtering tokens afterwards would leave the 做 / 法 unigrams behind and
 * drag the coverage score below the gate.
 */
export function stripDishModifiers(value) {
  let text = normalizeDishText(value);
  for (const word of DISH_MODIFIER_WORDS) {
    if (!word) continue;
    text = CJK_CHARACTER.test(word)
      ? text.split(word).join(" ")
      : text.replace(new RegExp(`\\b${word}\\b`, "g"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function significantDishTokens(dishQuery) {
  return dishTokens(stripDishModifiers(dishQuery));
}

function coverageOf(tokens, haystack) {
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (haystack.has(token)) matched += 1;
  }
  return matched / tokens.length;
}

const NONE_MATCH = Object.freeze({
  verdict: "none",
  score: 0,
  coverage: 0,
  matchedTokens: [],
  missingTokens: [],
});

function verdictRank(verdict) {
  return DISH_VERDICTS[verdict] ?? 0;
}

/** Token-coverage scoring for one candidate name (the dish, or one alias). */
function scoreBranch(recipe, branch) {
  const tokens = significantDishTokens(branch);
  const dishPhrase = stripDishModifiers(branch).replace(/\s+/g, "");
  if (tokens.length === 0 || !dishPhrase) return { ...NONE_MATCH };

  const titleText = normalizeDishText(recipe?.title || "");
  const titleTokens = dishTokenSet(recipe?.title || "");
  const bodyTokens = dishTokenSet(
    `${recipe?.title || ""} ${recipe?.description || ""}`
  );

  const titleCoverage = coverageOf(tokens, titleTokens);
  const bodyCoverage = coverageOf(tokens, bodyTokens);
  const coverage = Math.max(titleCoverage, bodyCoverage * 0.9);
  const matchedTokens = tokens.filter((token) => titleTokens.has(token));
  const missingTokens = tokens.filter((token) => !titleTokens.has(token));

  const collapsedTitle = titleText.replace(/\s+/g, "");
  const exact =
    collapsedTitle.length > 1 &&
    (collapsedTitle.includes(dishPhrase) ||
      (dishPhrase.length > 1 && dishPhrase.includes(collapsedTitle)));

  let verdict = "none";
  if (exact) verdict = "exact";
  else if (coverage >= 0.75) verdict = "strong";
  else if (coverage >= 0.5) verdict = "partial";

  const result = {
    verdict,
    score: Math.round(coverage * 1_000) / 1_000,
    coverage: Math.round(coverage * 1_000) / 1_000,
    matchedTokens,
    missingTokens,
  };
  return result;
}

/**
 * Scores how strongly a parsed recipe actually is the named dish.
 *
 *   exact   - the normalized dish phrase appears in the title
 *   strong  - >= 75% of the dish's significant tokens appear in the title
 *   partial - >= 50% (kept only as filler, never as a confident answer)
 *   none    - not the dish
 *
 * `aliases` are alternative names for the same dish (for example an English
 * name for a Chinese dish) and are tried as additional candidate names. They
 * are also the only cross-language path: the language service names the dish in
 * the other language, and the normal token coverage then applies.
 */
export function scoreDishMatch(recipe, dishQuery, { aliases = [] } = {}) {
  const branches = [
    dishQuery,
    ...(Array.isArray(aliases) ? aliases : []),
  ].filter((entry) => typeof entry === "string" && entry.trim());

  let best = { ...NONE_MATCH };
  let matchedAlias = null;
  for (const branch of branches) {
    const result = scoreBranch(recipe, branch);
    const better =
      verdictRank(result.verdict) > verdictRank(best.verdict) ||
      (verdictRank(result.verdict) === verdictRank(best.verdict) &&
        result.score > best.score);
    if (better) {
      best = result;
      matchedAlias = branch === dishQuery ? null : branch;
    }
  }
  return { ...best, matchedAlias };
}

/**
 * Keeps only recipes that pass the dish gate. `minimum` defaults to "strong",
 * which is what stops a cucumber-and-egg salad from being presented as a
 * tomato-egg stir fry.
 */
export function filterByDish(
  recipes,
  dishQuery,
  { minimum = "strong", aliases = [] } = {}
) {
  const threshold = DISH_VERDICTS[minimum] ?? DISH_VERDICTS.strong;
  const accepted = [];
  const rejected = [];
  for (const recipe of recipes) {
    const match = scoreDishMatch(recipe, dishQuery, { aliases });
    if ((DISH_VERDICTS[match.verdict] ?? 0) >= threshold) {
      accepted.push({ ...recipe, dishMatch: match });
    } else {
      rejected.push(recipe);
    }
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Query planning
// ---------------------------------------------------------------------------

// Templates are suffixed/ prefixed onto the dish exactly as the user named it.
// The English fallback slot is deliberate: it is how a Chinese user still
// reaches English-language publications that carry reliable structured data.
const DISH_QUERY_TEMPLATES = Object.freeze({
  en: [
    (dish) => `${dish} recipe`,
    (dish) => `how to make ${dish}`,
    (dish) => `${dish} easy recipe`,
  ],
  // Ordered by measured yield: 做法 and 食谱 both returned real recipe pages,
  // while negative operators (-youtube, -bilibili) measurably made results
  // worse, so variants are added rather than filtered in the query itself.
  zh: [
    (dish) => `${dish} 做法`,
    (dish) => `${dish} 食谱`,
    (dish) => `${dish} 家常做法`,
    (dish) => `${dish} 简易做法`,
    (dish) => `${dish} 怎么做`,
  ],
});

export function buildDishQueries(
  dishQuery,
  language,
  { maxQueries = defaultDishQueryBudget(language) } = {}
) {
  const raw = String(dishQuery ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  // The templates below supply the scaffolding ("recipe", "做法"); strip any
  // that leaked into dishQuery so queries do not read "… recipe recipe".
  const dish = stripDishModifiers(raw) || raw;
  if (!dish) return [];
  const normalizedLanguage = normalizeRecipeLanguage(language);
  const templates =
    DISH_QUERY_TEMPLATES[normalizedLanguage] ?? DISH_QUERY_TEMPLATES.en;
  const queries = templates.map((template) => template(dish));
  // The English fallbacks are deliberate: Chinese classics are well covered by
  // English-language publications, and those pages carried the most reliable
  // structured data in every run. This is what surfaced nanyangkitchen.
  if (normalizedLanguage !== "en") {
    queries.push(`${dish} recipe`);
    queries.push(`how to make ${dish}`);
  }
  queries.push(`${dish} calories total time`);

  const output = [];
  for (const query of queries) {
    const clipped = query.replace(/\s+/g, " ").trim().slice(0, 300);
    if (clipped && !output.includes(clipped)) output.push(clipped);
    if (output.length >= maxQueries) break;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Constraints (safety parity with the existing engine)
// ---------------------------------------------------------------------------

// Ported from recipeRecommendations.js so this module cannot silently skip an
// allergen or dietary exclusion. Keep the two tables in step if they change.
const ALLERGEN_GROUPS = Object.freeze({
  shellfish: ["shrimp", "prawn", "crab", "lobster", "crayfish", "crawfish", "scallop", "clam", "mussel", "oyster"],
  peanut: ["peanut", "groundnut"],
  peanuts: ["peanut", "groundnut"],
  "tree nut": ["almond", "brazil nut", "cashew", "hazelnut", "macadamia", "pecan", "pistachio", "walnut"],
  "tree nuts": ["almond", "brazil nut", "cashew", "hazelnut", "macadamia", "pecan", "pistachio", "walnut"],
  nuts: ["peanut", "almond", "brazil nut", "cashew", "hazelnut", "macadamia", "pecan", "pistachio", "walnut"],
  dairy: ["milk", "butter", "cheese", "cream", "yogurt", "yoghurt", "whey", "casein", "ghee"],
  egg: ["egg", "mayonnaise", "meringue"],
  eggs: ["egg", "mayonnaise", "meringue"],
  gluten: ["wheat", "barley", "rye", "spelt", "farro", "semolina", "couscous", "flour"],
  wheat: ["wheat", "spelt", "farro", "semolina", "couscous", "flour"],
  soy: ["soy", "soya", "tofu", "tempeh", "edamame", "miso"],
  sesame: ["sesame", "tahini"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "sardine", "trout", "halibut"],
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

export function createConstraintRules({
  allergens = [],
  excludedIngredients = [],
  dietaryPatterns = [],
} = {}) {
  const rules = [];
  const addRule = (label, terms) => {
    if (terms.length > 0) rules.push({ label, terms });
  };
  for (const allergen of allergens) {
    const key = normalizeDishText(allergen)
      .replace(/\b(?:allergy|allergies)\b/g, "")
      .trim();
    addRule(allergen, ALLERGEN_GROUPS[key] || [allergen]);
  }
  for (const excluded of excludedIngredients) {
    const key = normalizeDishText(excluded);
    addRule(excluded, ALLERGEN_GROUPS[key] || [excluded]);
  }
  for (const pattern of dietaryPatterns) {
    const key = normalizeDishText(pattern).replace(/\b(diet|food)\b/g, "").trim();
    if (DIET_EXCLUSIONS[key]) addRule(`diet:${pattern}`, DIET_EXCLUSIONS[key]);
  }
  return rules;
}

export function findConstraintConflict(
  recipe,
  rules,
  matchesIngredient = ingredientMatchesTerm
) {
  for (const rule of rules) {
    for (const ingredient of recipe.ingredients || []) {
      if (rule.terms.some((term) => matchesIngredient(term, ingredient))) {
        return { label: rule.label, ingredient };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preference constraints
// ---------------------------------------------------------------------------
//
// Dish mode must not ignore what the user asked for beyond the dish itself.
// Calorie and time ceilings stay soft penalties (publisher metadata is often
// missing), matching the existing engine's behaviour.

const ENERGY_PREFERENCES = new Set(["any", "light", "balanced", "hearty"]);

const MEAL_TYPE_BUCKETS = Object.freeze({
  breakfast: ["breakfast", "brunch"],
  lunch: ["lunch"],
  dinner: ["dinner", "supper", "main course", "main"],
  snack: ["snack"],
  dessert: ["dessert"],
});

export function canonicalMealType(value) {
  if (value == null) return null;
  const normalized = normalizeDishText(value);
  if (!normalized) return null;
  for (const [bucket, terms] of Object.entries(MEAL_TYPE_BUCKETS)) {
    if (
      bucket === normalized ||
      terms.some((term) => normalizeDishText(term) === normalized)
    ) {
      return bucket;
    }
  }
  return null;
}

export function normalizeEnergyPreference(value) {
  const normalized = normalizeDishText(value).replace(/ /g, "_");
  const aliases = {
    low_calorie: "light",
    healthy: "light",
    filling: "hearty",
    comfort: "hearty",
    none: "any",
  };
  const resolved = aliases[normalized] || normalized;
  return ENERGY_PREFERENCES.has(resolved) ? resolved : "any";
}

function boundedInteger(value, { min, max }) {
  if (!Number.isFinite(value)) return null;
  const integer = Math.round(value);
  return integer >= min && integer <= max ? integer : null;
}

/**
 * True only when the publisher's own metadata proves a different meal type.
 * Unknown metadata is never a mismatch, so unlabelled recipes stay eligible.
 */
export function mealTypeMismatch(recipe, bucket) {
  if (!bucket) return false;
  const terms = MEAL_TYPE_BUCKETS[bucket] || [];
  const matchesText = (text) => {
    const haystack = dishTokenSet(text);
    return terms.some((term) => {
      const words = dishTokens(term);
      return words.length > 0 && words.every((word) => haystack.has(word));
    });
  };
  const categoryText = Array.isArray(recipe.mealTypes)
    ? recipe.mealTypes.join(" ")
    : String(recipe.mealTypes || "");
  if (categoryText.trim()) return !matchesText(categoryText);
  return false;
}

/**
 * "Light" / "hearty" is a coarse preference, not a nutrition model. Unknown
 * calories return null so the recipe is neither favoured nor penalised.
 */
export function matchesEnergyPreference(recipe, energyPreference) {
  const calories = recipe.caloriesPerServing;
  if (calories == null) return null;
  if (energyPreference === "light") return calories <= 500;
  if (energyPreference === "hearty") return calories >= 500;
  return null;
}

/**
 * A stated ceiling is a filter, not a tunable penalty: recipes that break it
 * are dropped when enough alternatives remain, and otherwise ranked last.
 */
export function violatesLimits(
  recipe,
  { maxCaloriesPerServing, maxPrepMinutes, maxIngredients } = {}
) {
  if (
    maxCaloriesPerServing != null &&
    recipe.caloriesPerServing != null &&
    recipe.caloriesPerServing > maxCaloriesPerServing
  ) {
    return true;
  }
  if (
    maxPrepMinutes != null &&
    recipe.totalMinutes != null &&
    recipe.totalMinutes > maxPrepMinutes
  ) {
    return true;
  }
  if (
    maxIngredients != null &&
    (recipe.ingredients || []).length > maxIngredients
  ) {
    return true;
  }
  return false;
}

export function applyLimits(recipes, limits, minimum) {
  return filterWhenEnough(
    recipes,
    (recipe) => !violatesLimits(recipe, limits),
    minimum
  );
}

/**
 * Every preference filter follows the same rule: drop non-matching recipes
 * only while enough alternatives remain, so no preference can empty the answer.
 */
export function filterWhenEnough(recipes, predicate, minimum) {
  const matches = recipes.filter(predicate);
  const floor = Math.min(Number.isFinite(minimum) ? minimum : 1, recipes.length);
  return matches.length >= floor ? matches : recipes;
}

export function cuisineMatches(preference, recipe) {
  const normalized = normalizeDishText(preference);
  if (!normalized) return false;
  const haystack = dishTokenSet(
    `${recipe.title || ""} ${(recipe.cuisines || []).join(" ")}`
  );
  const words = dishTokens(preference);
  return words.length > 0 && words.every((word) => haystack.has(word));
}

export function matchesPreferredCuisine(recipe, preferredCuisines) {
  const preferences = Array.isArray(preferredCuisines) ? preferredCuisines : [];
  return preferences.some((entry) => cuisineMatches(entry, recipe));
}

export function dislikedIngredientPenalty(
  recipe,
  dislikedIngredients,
  matchesIngredient = ingredientMatchesTerm
) {
  const dislikes = Array.isArray(dislikedIngredients) ? dislikedIngredients : [];
  if (dislikes.length === 0) return 0;
  let matched = 0;
  for (const dislike of dislikes) {
    if (
      (recipe.ingredients || []).some((ingredient) =>
        matchesIngredient(dislike, ingredient)
      )
    ) {
      matched += 1;
    }
  }
  return Math.min(0.18, matched * 0.06);
}

// ---------------------------------------------------------------------------
// AI helpers: dish aliases and result translation
// ---------------------------------------------------------------------------

const DEFAULT_TRANSLATION_MODEL = MODEL_RECIPE_TRANSLATION;
const MAX_ALIAS_CACHE_ENTRIES = 200;
const MAX_TRANSLATION_STRINGS = 240;
const MAX_TRANSLATION_CHARS = 20_000;
// Chunks are bounded by characters, not string count: a response that is too
// large comes back truncated or with strings echoed untranslated, and a failed
// chunk degrades only its own slice.
const TRANSLATION_CHUNK_CHARS = 2_000;
const TRANSLATION_CHUNK_STRINGS = 40;
const MAX_TRANSLATION_OUTPUT_TOKENS = 4_000;
const TRANSLATION_CONCURRENCY = 4;

function cleanList(value, maxItems) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * Results must come back in the language the user set in the app. This is on
 * by default; set RECIPE_TRANSLATION=false to disable.
 */
export function recipeTranslationEnabled(env = process.env) {
  const raw = String(env?.RECIPE_TRANSLATION ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(?:0|false|no|off)$/.test(raw);
}

export function translationModel(env = process.env) {
  return (
    String(env?.RECIPE_TRANSLATION_MODEL || "").trim() ||
    DEFAULT_TRANSLATION_MODEL
  );
}

function dominantScript(value) {
  const text = String(value || "");
  const cjk = (text.match(new RegExp(`[${CJK_RANGES}]`, "g")) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && latin === 0) return "none";
  return cjk > latin ? "cjk" : "latin";
}

/**
 * True when this text is written in a different script than the app language,
 * so translating it actually changes something.
 */
export function needsTranslation(value, language) {
  const target = normalizeRecipeLanguage(language);
  if (target !== "en" && target !== "zh") return false;
  const script = dominantScript(value);
  if (script === "none") return false;
  if (target === "zh") {
    // Latin text needs translating, and Traditional Chinese needs converting:
    // a zh-TW page is the wrong script for a zh-CN reader.
    return script === "latin" || looksTraditional(value);
  }
  return script === "cjk";
}

function createJsonChatClient({
  apiKey = OPENAI_API_KEY,
  model = translationModel(),
  fetchImpl = fetch,
  timeoutMs = 12_000,
  maxOutputTokens = 2_000,
} = {}) {
  return async function jsonChat(
    system,
    user,
    { signal, maxOutputTokens: callMaxOutputTokens } = {}
  ) {
    if (!apiKey) return null;
    const outputTokens =
      Number.isFinite(callMaxOutputTokens) && callMaxOutputTokens > 0
        ? Math.min(16_000, Math.trunc(callMaxOutputTokens))
        : maxOutputTokens;
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("AI helper timed out.")),
      timeoutMs
    );
    timer.unref?.();
    try {
      const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
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
          max_completion_tokens: outputTokens,
          temperature: 0,
        }),
        signal: controller.signal,
      });
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

const ALIAS_SYSTEM_PROMPT = `You give alternative names for a dish so a recipe search can recognise it in other languages.
Rules:
- Return the dish name in English plus at most 3 other common names.
- Use the name real recipe sites would publish, never a description or an ingredient list.
Respond with ONLY JSON: {"aliases":["...","..."]}`;

/**
 * Best-effort alternative names for a dish. This is what lets a proper-noun
 * dish such as 麻婆豆腐 match an English page titled "Mapo Tofu", which the
 * ingredient-concept path cannot reach on its own.
 */
export function createDishAliasExpander(options = {}) {
  const jsonChat = createJsonChatClient(options);
  const cache = new Map();
  return async function expandDishAliases(dish, language, { signal } = {}) {
    const name = String(dish || "").trim();
    if (!name) return [];
    const key = `${normalizeRecipeLanguage(language)}|${name.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const parsed = await jsonChat(
      ALIAS_SYSTEM_PROMPT,
      JSON.stringify({ dish: name, language: normalizeRecipeLanguage(language) }),
      { signal }
    );
    const aliases = Array.isArray(parsed?.aliases)
      ? parsed.aliases
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry && entry.toLowerCase() !== name.toLowerCase())
          .slice(0, 4)
      : [];
    if (cache.size >= MAX_ALIAS_CACHE_ENTRIES) cache.clear();
    cache.set(key, aliases);
    return aliases;
  };
}

const TRANSLATION_SYSTEM_PROMPT = `You adapt published recipe content to the language the user set in their app.
Rules:
- If a string is written in another language, translate it into the requested language.
- If a string is Chinese but written in Traditional characters and the requested language is zh, convert it to Simplified characters. Do not otherwise change Chinese that is already in the requested form.
- Keep numbers, units, temperatures, times and brand names exactly as written.
- Do not add, remove, merge or explain anything.
- Keep each output array the same length and order as its input.
Respond with ONLY JSON: {"strings":["...","..."]}`;

// Field order matters: title and ingredient lists are what the card shows, so
// they are translated before long instruction text.
const TRANSLATION_FIELD_ORDER = Object.freeze([
  "title",
  "ingredients",
  "missingIngredients",
  "description",
  "instructions",
  "whyRecommended",
]);

function fieldValues(recipe, field) {
  if (
    field === "title" ||
    field === "description" ||
    field === "whyRecommended"
  ) {
    const value = recipe?.[field];
    return typeof value === "string" && value ? [[null, value]] : [];
  }
  return (recipe?.[field] || []).map((value, index) => [index, value]);
}

/**
 * All the strings a recipe set would translate, ordered field-major across
 * recipes. Interleaving this way means a budget cut shortens every recipe a
 * little instead of dropping whole recipes off the end.
 */
function translatableSlots(recipes) {
  const slots = [];
  for (const field of TRANSLATION_FIELD_ORDER) {
    recipes.forEach((recipe, recipeIndex) => {
      for (const [index, value] of fieldValues(recipe, field)) {
        slots.push({ recipeIndex, field, index, value });
      }
    });
  }
  return slots;
}

/** How many strings would actually change language. Used for meta reporting. */
export function countTranslatableStrings(recipes, language) {
  const target = normalizeRecipeLanguage(language);
  if (target !== "en" && target !== "zh") return 0;
  const list = Array.isArray(recipes) ? recipes : [];
  return translatableSlots(list).filter(({ value }) =>
    needsTranslation(value, target)
  ).length;
}

/**
 * Translates the user-facing text of already-selected recipes into the app
 * language, so an English page is returned to a Chinese user in Chinese.
 * Best-effort: any failure returns the original text.
 */
export function createRecipeTranslator(options = {}) {
  const jsonChat = createJsonChatClient(options);
  return async function translateRecipes(recipes, language, { signal } = {}) {
    const target = normalizeRecipeLanguage(language);
    const list = Array.isArray(recipes) ? recipes : [];
    if (list.length === 0 || (target !== "en" && target !== "zh")) return list;

    // Collect only the strings that actually need translating.
    const allSlots = translatableSlots(list).filter(
      ({ value }) =>
        typeof value === "string" && needsTranslation(value, target)
    );
    if (allSlots.length === 0) return list;
    const slots = allSlots.slice(0, MAX_TRANSLATION_STRINGS);
    const strings = slots.map(({ value }) => value);

    // Identical strings are translated once. Ingredient lists and "missing"
    // lists repeat a lot of text, and deduplication is what leaves room in the
    // character budget for the instruction steps.
    const uniqueStrings = [];
    const uniqueIndexByValue = new Map();
    const slotUniqueIndex = strings.map((value) => {
      const existing = uniqueIndexByValue.get(value);
      if (existing !== undefined) return existing;
      const index = uniqueStrings.length;
      uniqueIndexByValue.set(value, index);
      uniqueStrings.push(value);
      return index;
    });

    const budgetedIndices = [];
    let characters = 0;
    for (let index = 0; index < uniqueStrings.length; index += 1) {
      const value = uniqueStrings[index];
      if (characters + value.length > MAX_TRANSLATION_CHARS) break;
      characters += value.length;
      budgetedIndices.push(index);
    }
    if (budgetedIndices.length === 0) return list;

    const output = list.map((recipe) => ({ ...recipe }));
    const appliedPerRecipe = new Array(list.length).fill(0);

    // Chunks are independent, so they run concurrently: translation sits on the
    // critical path and a typical result needs two or three of them.
    const chunks = [];
    let pending = [];
    let pendingChars = 0;
    const flush = () => {
      if (pending.length === 0) return;
      chunks.push({
        indices: pending,
        values: pending.map((index) => uniqueStrings[index]),
      });
      pending = [];
      pendingChars = 0;
    };
    for (const index of budgetedIndices) {
      const length = uniqueStrings[index].length;
      if (
        pending.length > 0 &&
        (pendingChars + length > TRANSLATION_CHUNK_CHARS ||
          pending.length >= TRANSLATION_CHUNK_STRINGS)
      ) {
        flush();
      }
      pending.push(index);
      pendingChars += length;
    }
    flush();

    const results = new Array(chunks.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        if (signal?.aborted) return;
        const chunk = chunks[index];
        // One retry: a misaligned or truncated response is usually transient,
        // and a chunk that still fails simply keeps its original text.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const parsed = await jsonChat(
            TRANSLATION_SYSTEM_PROMPT,
            JSON.stringify({ language: target, strings: chunk.values }),
            { signal, maxOutputTokens: MAX_TRANSLATION_OUTPUT_TOKENS }
          );
          const translatedChunk = Array.isArray(parsed?.strings)
            ? parsed.strings
            : null;
          if (
            translatedChunk &&
            translatedChunk.length === chunk.values.length
          ) {
            results[index] = translatedChunk;
            return;
          }
          if (signal?.aborted) return;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(TRANSLATION_CONCURRENCY, chunks.length) },
        () => worker()
      )
    );

    const translatedByUniqueIndex = new Map();
    results.forEach((translatedChunk, index) => {
      if (!translatedChunk) return;
      const chunk = chunks[index];
      for (let offset = 0; offset < chunk.values.length; offset += 1) {
        const value = translatedChunk[offset];
        if (typeof value !== "string" || !value.trim()) continue;
        translatedByUniqueIndex.set(chunk.indices[offset], value);
      }
    });

    slots.forEach((slot, index) => {
      const value = translatedByUniqueIndex.get(slotUniqueIndex[index]);
      if (value === undefined || value === slot.value) return;
      const recipe = output[slot.recipeIndex];
      if (slot.index === null) {
        if (slot.field === "title" && !recipe.originalTitle) {
          recipe.originalTitle = recipe.title;
        }
        recipe[slot.field] = value;
      } else {
        recipe[slot.field] = [...recipe[slot.field]];
        recipe[slot.field][slot.index] = value;
      }
      appliedPerRecipe[slot.recipeIndex] += 1;
    });
    if (appliedPerRecipe.every((count) => count === 0)) return list;
    // What each recipe would have needed, so a budget cut is visible rather
    // than silently reported as a complete translation.
    const expectedPerRecipe = new Array(list.length).fill(0);
    for (const slot of allSlots) {
      expectedPerRecipe[slot.recipeIndex] += 1;
    }
    // Mark only the recipes that actually changed: a recipe whose strings were
    // cut by the budget must not claim to be translated.
    return output.map((recipe, index) =>
      appliedPerRecipe[index] > 0
        ? {
            ...recipe,
            translation: {
              to: target,
              provider: "ai",
              fields: appliedPerRecipe[index],
              partial: appliedPerRecipe[index] < expectedPerRecipe[index],
            },
          }
        : recipe
    );
  };
}

export const expandDishAliases = createDishAliasExpander();
export const translateRecipes = createRecipeTranslator();

const INGREDIENT_VARIANTS_SYSTEM_PROMPT = `You prepare ingredient names so a matcher can recognise the same ingredient however a recipe writes it.
For each ingredient return two lists:

same - up to 6 other names that mean this ingredient:
- the English name, and the Simplified and Traditional Chinese name when one exists
- the cuts, parts and forms a recipe would call it (beef -> chuck, brisket, short rib, flank steak, stew meat)
- only names that always mean this ingredient; never a word that can also name something else (do not put "rib" under beef, because it also names pork ribs)

notSame - up to 6 products that contain the ingredient's name but are a different ingredient (beef -> beef broth, beef stock, beef bouillon, beef jerky). Omit the list when there is nothing to say.

Rules:
- Names only: no quantities, brands or explanations.
- Use the names real recipe sites publish.
Respond with ONLY JSON: {"items":[{"name":"...","same":["..."],"notSame":["..."]}]}`;

/**
 * Language-service expansion for ingredient names. This is what lets a fridge
 * item named 鸡蛋 match 雞蛋, egg, or a page that writes 蛋液, without any of
 * those spellings being hard-coded here.
 */
export function createIngredientVariantExpander(options = {}) {
  const jsonChat = createJsonChatClient(options);
  const cache = new Map();
  return async function expandIngredientNames(names, language, { signal } = {}) {
    const list = [
      ...new Set(
        (Array.isArray(names) ? names : [])
          .map((entry) => String(entry || "").trim())
          .filter(Boolean)
      ),
    ].slice(0, 40);
    if (list.length === 0) return {};

    const normalizedLanguage = normalizeRecipeLanguage(language);
    const key = `${normalizedLanguage}|${list
      .map((entry) => entry.toLowerCase())
      .sort()
      .join("|")}`;
    if (cache.has(key)) return cache.get(key);

    const parsed = await jsonChat(
      INGREDIENT_VARIANTS_SYSTEM_PROMPT,
      JSON.stringify({ language: normalizedLanguage, ingredients: list }),
      { signal, maxOutputTokens: 2_000 }
    );

    const table = {};
    for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
      const name = String(entry?.name || "").trim();
      if (!name) continue;
      const original =
        list.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ??
        name;
      const same = cleanList(
        Array.isArray(entry?.same)
          ? entry.same
          : Array.isArray(entry?.variants)
            ? entry.variants
            : [],
        6
      );
      const notSame = cleanList(entry?.notSame, 6);
      if (same.length > 0 || notSame.length > 0) {
        table[original] = { same, notSame };
      }
    }

    if (cache.size >= MAX_ALIAS_CACHE_ENTRIES) cache.clear();
    cache.set(key, table);
    return table;
  };
}

export const expandIngredientNames = createIngredientVariantExpander();

// ---------------------------------------------------------------------------
// Search + fetch
// ---------------------------------------------------------------------------

/**
 * Serper search with an explicit host language. The existing TOOLS.webSearch
 * only sends { q, num }; this keeps hl/gl available without editing it.
 */
export function createSerperSearch({
  apiKey = SERPER_API_KEY,
  fetchImpl = fetch,
  endpoint = "https://google.serper.dev/search",
  timeoutMs = 10_000,
} = {}) {
  return async function serperSearch(args, ctx) {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const k = Number.isFinite(args?.k) ? Math.max(1, Math.min(10, args.k)) : 5;
    if (!query) return { query, results: [] };
    if (!apiKey) {
      return { error: "Missing SERPER_API_KEY on server", query, results: [] };
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(ctx?.signal?.reason);
    if (ctx?.signal?.aborted) forwardAbort();
    else ctx?.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Search timed out.")), timeoutMs);
    timer.unref?.();

    try {
      const body = { q: query, num: k };
      if (args?.hl) body.hl = args.hl;
      if (args?.gl) body.gl = args.gl;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { error: `Serper error ${response.status}`, query, results: [] };
      }
      const data = await response.json().catch(() => ({}));
      const organic = Array.isArray(data?.organic) ? data.organic : [];
      return {
        query,
        results: organic.slice(0, k).map((entry) => ({
          title: entry?.title || "",
          link: entry?.link || "",
          snippet: entry?.snippet || "",
        })),
      };
    } catch {
      return { error: "Web search is temporarily unavailable.", query, results: [] };
    } finally {
      clearTimeout(timer);
      ctx?.signal?.removeEventListener("abort", forwardAbort);
    }
  };
}

export const dishSerperSearch = createSerperSearch();

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
    return normalizeDishText(value);
  }
}

function normalizedResults(value) {
  const source = Array.isArray(value) ? value : value?.results;
  if (!Array.isArray(source)) return [];
  const output = [];
  for (const entry of source) {
    try {
      const url = new URL(String(entry?.link ?? entry?.url ?? ""));
      if (!new Set(["http:", "https:"]).has(url.protocol)) continue;
      if (url.username || url.password) continue;
      url.hash = "";
      output.push({
        title: String(entry?.title || "").slice(0, 180),
        link: url.href,
        snippet: String(entry?.snippet || "").slice(0, 400),
      });
    } catch {
      // Ignore malformed result URLs; the safe fetcher validates for real.
    }
  }
  return output;
}

function createDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forward();
  else parentSignal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Dish search timed out."));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", forward);
    },
  };
}

// ---------------------------------------------------------------------------
// Ranking + output
// ---------------------------------------------------------------------------

function qualityScore(recipe) {
  return (
    0.3 +
    ((recipe.instructions || []).length > 0 ? 0.25 : 0) +
    (recipe.caloriesPerServing != null ? 0.2 : 0) +
    (recipe.totalMinutes != null ? 0.15 : 0) +
    ((recipe.cuisines || []).length > 0 ? 0.1 : 0)
  );
}

function matchInventory(
  recipe,
  inventory,
  matchesIngredient = ingredientMatchesTerm
) {
  const used = [];
  const usedIndexes = new Set();
  for (const item of inventory) {
    const index = (recipe.ingredients || []).findIndex((ingredient) =>
      matchesIngredient(item, ingredient)
    );
    if (index >= 0) {
      used.push(item);
      usedIndexes.add(index);
    }
  }
  return {
    usedIngredients: used,
    missingIngredients: (recipe.ingredients || []).filter(
      (_ingredient, index) => !usedIndexes.has(index)
    ),
  };
}

function buildWhyRecommended(recipe, { used, dishQuery, language }) {
  const messages = messagesFor(language);
  const reasons = [];
  if (dishQuery) reasons.push(messages.matchesDish(dishQuery));
  if (used.length > 0) reasons.push(messages.fridgeItems(used.length));
  if (reasons.length === 0) reasons.push(messages.completeData);
  const sentence = reasons.slice(0, 3).join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

function publicRecipe(candidate, context) {
  const { dishMatch, score, scoreBreakdown, _index, ...recipe } = candidate;
  const used = candidate.usedIngredients || [];
  const missing = candidate.missingIngredients || [];
  return {
    ...recipe,
    ingredients: (recipe.ingredients || []).slice(0, 30),
    instructions: (recipe.instructions || []).slice(0, 12),
    usedIngredients: used.slice(0, 20),
    missingIngredients: missing.slice(0, 30),
    dish: {
      query: context.dishQuery,
      verdict: dishMatch.verdict,
      match: dishMatch.score,
      matchedTokens: dishMatch.matchedTokens.slice(0, 12),
    },
    score,
    scoreBreakdown,
    whyRecommended: buildWhyRecommended(recipe, {
      used,
      dishQuery: context.dishQuery,
      language: context.language,
    }),
  };
}

function selectDiverse(candidates, count) {
  const remaining = [...candidates];
  const selected = [];
  const domains = new Map();
  while (remaining.length > 0 && selected.length < count) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const recipe = remaining[index];
      let domain = "";
      try {
        domain = new URL(recipe.url).hostname.replace(/^www\./i, "");
      } catch {
        domain = "";
      }
      const domainCount = domains.get(domain) || 0;
      const adjusted = recipe.score - domainCount * 0.1;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    let domain = "";
    try {
      domain = new URL(chosen.url).hostname.replace(/^www\./i, "");
    } catch {
      domain = "";
    }
    domains.set(domain, (domains.get(domain) || 0) + 1);
    selected.push(chosen);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Searches for one named dish, in the user's language, and returns published
 * recipes that are actually that dish.
 *
 * Unlike the inventory-driven engine, this path:
 *   - always includes the dish's own queries (no ideation, no fridge queries),
 *   - enforces the dish identity gate before anything is returned,
 *   - never substitutes a different dish to avoid an empty result.
 */
export async function searchRecipesByDish(
  {
    dishQuery,
    language = "en",
    inventory = [],
    resultCount = DEFAULT_DISH_RESULT_COUNT,
    maxResultCount = MAX_DISH_RESULT_COUNT,
    allergens = [],
    excludedIngredients = [],
    dietaryPatterns = [],
    aliases = [],
    mealType,
    energyPreference = "any",
    maxCaloriesPerServing,
    maxPrepMinutes,
    preferredCuisines = [],
    dislikedIngredients = [],
    maxIngredients,
    servings,
    deniedHosts = DEFAULT_DENIED_HOST_PATTERNS,
    limits: requestedLimits,
    minimumVerdict = "strong",
    signal,
  } = {},
  {
    search = dishSerperSearch,
    fetchPage = fetchPublicTextPage,
    parsePage = parseRecipeJsonLd,
    expandDish = expandDishAliases,
    expandIngredients = expandIngredientNames,
    translate = translateRecipes,
    translationEnabled = recipeTranslationEnabled(),
    aliasExpansionEnabled = true,
  } = {}
) {
  if (typeof search !== "function" || typeof fetchPage !== "function") {
    throw new TypeError("search and fetchPage must be functions");
  }

  const dish = String(dishQuery ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const normalizedLanguage = normalizeRecipeLanguage(language);
  const locale = serperLocaleFor(normalizedLanguage);
  const limits = {
    ...DEFAULT_DISH_LIMITS,
    maxSearchQueries: defaultDishQueryBudget(normalizedLanguage),
    ...(requestedLimits || {}),
  };
  const wanted = Math.max(
    1,
    Math.min(Number.isFinite(resultCount) ? Math.trunc(resultCount) : DEFAULT_DISH_RESULT_COUNT, maxResultCount)
  );
  const warnings = [];
  const pushWarning = (code, message) => {
    if (!warnings.some((entry) => entry.code === code)) warnings.push({ code, message });
  };
  const messages = messagesFor(normalizedLanguage);
  const constraints = createConstraintRules({
    allergens,
    excludedIngredients,
    dietaryPatterns,
  });
  const providedAliases = (Array.isArray(aliases) ? aliases : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const baseQueries = buildDishQueries(dish, normalizedLanguage, {
    maxQueries: limits.maxSearchQueries,
  });

  const emptyMeta = {
    language: normalizedLanguage,
    dishQuery: dish,
    queries: baseQueries,
    queriesRun: 0,
    pagesConsidered: 0,
    hostFilter: { enabled: false, resultsSkipped: 0, hostsSkipped: [] },
    pagesFetched: 0,
    candidatesParsed: 0,
    dishGate: { exact: 0, strong: 0, partial: 0, rejected: 0 },
    returnedCount: 0,
    why: dish ? "NO_DISH_QUERY" : "MISSING_DISH",
  };

  if (!dish) {
    pushWarning("NO_MATCHING_DISH", messages.noDish(""));
    return { recipes: [], warnings, meta: { ...emptyMeta, why: "MISSING_DISH" } };
  }

  const deadline = createDeadline(signal, limits.overallTimeoutMs);
  let queriesRun = 0;
  let failedSearches = 0;
  let skippedHostResults = 0;
  let aliasesUsed = [...providedAliases];
  let aliasExpansion = "skipped";
  let translation = {
    enabled: Boolean(translationEnabled),
    requested: 0,
    applied: 0,
    failed: 0,
  };
  const skippedHosts = new Set();

  try {
    // 0. Language services start first and run while the search is in flight.
    //    Every translation-shaped decision is delegated: the built-in
    //    vocabulary is only a free fast path, never the ceiling.
    const termSet = [
      ...new Set([
        ...(Array.isArray(inventory) ? inventory.filter(Boolean) : []),
        ...(Array.isArray(dislikedIngredients) ? dislikedIngredients : []),
        ...constraints.flatMap((rule) => rule.terms),
      ]),
    ].map((entry) => String(entry).trim()).filter(Boolean);

    const aliasRequest =
      aliasExpansionEnabled &&
      typeof expandDish === "function" &&
      providedAliases.length === 0
        ? Promise.resolve(
            expandDish(dish, normalizedLanguage, { signal: deadline.signal })
          ).then(
            (value) => ({ ok: true, value }),
            () => ({ ok: false, value: null })
          )
        : null;
    const variantRequest =
      typeof expandIngredients === "function" && termSet.length > 0
        ? Promise.resolve(
            expandIngredients(termSet, normalizedLanguage, {
              signal: deadline.signal,
            })
          ).then(
            (value) => ({ ok: true, value }),
            () => ({ ok: false, value: null })
          )
        : null;

    if (providedAliases.length > 0) aliasExpansion = "provided";

    // Alias queries are reserved out of the budget so they always run, even
    // when the localized templates already fill it.
    const reserved = aliasRequest ? 2 : 0;
    const primaryQueries = buildDishQueries(dish, normalizedLanguage, {
      maxQueries: Math.max(1, limits.maxSearchQueries - reserved),
    });

    // 1. Search every dish query, newest links first, deduped.
    const seen = new Map();
    const runQueries = async (queryList) => {
      for (const query of queryList) {
        if (deadline.signal.aborted) return;
        if (seen.size >= limits.maxPages) return;
        queriesRun += 1;
        let response;
        try {
          response = await search(
            {
              query,
              k: limits.searchResultsPerQuery,
              hl: locale.hl,
              gl: locale.gl,
            },
            { signal: deadline.signal }
          );
        } catch {
          failedSearches += 1;
          continue;
        }
        if (response?.error) failedSearches += 1;
        for (const result of normalizedResults(response).slice(
          0,
          limits.searchResultsPerQuery
        )) {
          const host = hostnameOf(result.link);
          if (isDeniedHost(host, deniedHosts)) {
            skippedHostResults += 1;
            if (skippedHosts.size < 20) skippedHosts.add(host);
            continue;
          }
          const key = canonicalUrl(result.link);
          if (!seen.has(key)) seen.set(key, result);
          if (seen.size >= limits.maxPages) break;
        }
      }
    };
    await runQueries(primaryQueries);

    // 2. Collect the language-service results and spend the reserved budget on
    //    the alternative names they produced.
    let aliasQueries = [];
    if (aliasRequest) {
      const outcome = await aliasRequest;
      const expanded = outcome?.value;
      if (!outcome?.ok) {
        aliasExpansion = "failed";
      } else if (Array.isArray(expanded) && expanded.length > 0) {
        aliasesUsed = expanded
          .map((entry) => String(entry || "").trim())
          .filter(Boolean)
          .slice(0, 8);
        aliasExpansion = "expanded";
      } else {
        aliasExpansion = "empty";
      }
      aliasQueries = aliasesUsed
        .map((entry) => `${entry} recipe`)
        .filter((entry) => !primaryQueries.includes(entry))
        .slice(0, reserved);
      await runQueries(aliasQueries);
    }
    const queries = [...primaryQueries, ...aliasQueries].slice(
      0,
      limits.maxSearchQueries
    );

    const pages = [...seen.values()].slice(0, limits.maxPages);
    if (failedSearches > 0) {
      pushWarning("SEARCH_PARTIALLY_UNAVAILABLE", messages.partialPages);
    }

    // 2. Fetch pages with bounded concurrency.
    const parsedPages = new Array(pages.length);
    let cursor = 0;
    let failedPages = 0;
    let truncatedPages = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= pages.length) return;
        if (deadline.signal.aborted) return;
        const page = pages[index];
        try {
          const fetched = await fetchPage(page.link, {
            signal: deadline.signal,
            timeoutMs: limits.pageTimeoutMs,
            maxBytes: limits.pageMaxBytes,
            maxRedirects: 3,
          });
          if (typeof fetched?.text !== "string") {
            failedPages += 1;
            continue;
          }
          if (fetched.truncated) truncatedPages += 1;
          let recipes =
            parsePage(fetched.text, {
              pageUrl: fetched.url || page.link,
              maxRecipes: limits.maxRecipesPerPage,
            })?.recipes || [];
          if (recipes.length === 0) {
            recipes = await extractRecipesFromPage(fetched.text, {
              pageUrl: fetched.url || page.link,
              language: normalizedLanguage,
              signal: deadline.signal,
            });
          }
          parsedPages[index] = recipes;
        } catch {
          failedPages += 1;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limits.fetchConcurrency, pages.length) }, () => worker())
    );

    const parsed = parsedPages.flat();
    if (failedPages > 0) {
      pushWarning("PAGES_PARTIALLY_UNAVAILABLE", "One or more recipe pages could not be read safely.");
    }
    if (truncatedPages > 0) {
      pushWarning("PAGES_TRUNCATED", "One or more large recipe pages were truncated before parsing.");
    }

    // 3. Ingredient variants from the language service, then safety
    //    constraints, then the dish identity gate.
    const variantTable = variantRequest
      ? (await variantRequest)?.value ?? {}
      : {};
    const ingredientVariants = buildIngredientVariants(termSet, variantTable);
    const ingredientExclusions = buildIngredientExclusions(
      termSet,
      variantTable
    );
    const matchesIngredient = createIngredientMatcher(
      ingredientVariants,
      ingredientExclusions
    );
    const variantCount = [...ingredientVariants.values()].reduce(
      (total, list) => total + Math.max(0, list.length - 1),
      0
    );
    const exclusionCount = [...ingredientExclusions.values()].reduce(
      (total, list) => total + list.length,
      0
    );

    const safe = parsed.filter(
      (recipe) =>
        !findConstraintConflict(recipe, constraints, matchesIngredient)
    );
    const gated = filterByDish(safe, dish, {
      minimum: minimumVerdict,
      aliases: aliasesUsed,
    });

    const gateCounts = {
      exact: 0,
      strong: 0,
      partial: 0,
      alias: 0,
      rejected: gated.rejected.length,
    };
    for (const recipe of gated.accepted) {
      gateCounts[recipe.dishMatch.verdict] =
        (gateCounts[recipe.dishMatch.verdict] || 0) + 1;
      if (recipe.dishMatch.matchedAlias) gateCounts.alias += 1;
    }

    // 4. Preference filters. Each one drops non-matching dishes only while
    //    enough alternatives remain, so a filter can never empty the answer.
    const mealTypeBucket = canonicalMealType(mealType);
    const energy = normalizeEnergyPreference(energyPreference);
    const calorieCeiling = boundedInteger(maxCaloriesPerServing, {
      min: 100,
      max: 2_500,
    });
    const timeCeiling = boundedInteger(maxPrepMinutes, { min: 5, max: 480 });
    const ingredientCeiling = boundedInteger(maxIngredients, {
      min: 3,
      max: 30,
    });
    const preferenceLimits = {
      maxCaloriesPerServing: calorieCeiling,
      maxPrepMinutes: timeCeiling,
      maxIngredients: ingredientCeiling,
    };
    const cuisines = (Array.isArray(preferredCuisines) ? preferredCuisines : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    const dislikes = (Array.isArray(dislikedIngredients)
      ? dislikedIngredients
      : []
    )
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, 30);

    const mealFiltered = filterWhenEnough(
      gated.accepted,
      (recipe) => !mealTypeMismatch(recipe, mealTypeBucket),
      wanted
    );
    const limited = applyLimits(mealFiltered, preferenceLimits, wanted);

    // 5. Rank the dishes that already passed the gate. Dish fidelity dominates;
    //    preferences and fridge overlap only order the survivors.
    const inventoryItems = Array.isArray(inventory)
      ? inventory.filter(Boolean)
      : [];

    const scored = limited.map((recipe, index) => {
      const inventoryMatch = matchInventory(
        recipe,
        inventoryItems,
        matchesIngredient
      );
      const breakdown = {
        dish: recipe.dishMatch.score,
        quality: qualityScore(recipe),
        mealType: mealTypeMismatch(recipe, mealTypeBucket) ? 0 : 1,
        // Fridge overlap is a tiebreaker here, never the reason a recipe wins:
        // that inversion is what surfaced cucumber-and-egg salads for a
        // tomato-and-egg stir fry request.
        fridge: inventoryItems.length
          ? Math.min(
              1,
              inventoryMatch.usedIngredients.length /
                Math.min(10, inventoryItems.length)
            )
          : 0,
        cuisine: matchesPreferredCuisine(recipe, cuisines) ? 1 : 0,
        energy: matchesEnergyPreference(recipe, energy) === true ? 1 : 0,
        overLimit: violatesLimits(recipe, preferenceLimits) ? 1 : 0,
        disliked: dislikedIngredientPenalty(
          recipe,
          dislikes,
          matchesIngredient
        ),
      };
      const score = Math.max(
        0,
        breakdown.dish * 0.6 +
          breakdown.quality * 0.15 +
          breakdown.fridge * 0.05 +
          breakdown.cuisine * 0.05 +
          breakdown.mealType * 0.05 +
          breakdown.energy * 0.05 -
          breakdown.overLimit * 0.15 -
          breakdown.disliked
      );
      return {
        ...recipe,
        ...inventoryMatch,
        score: Math.round(score * 1_000) / 1_000,
        scoreBreakdown: breakdown,
        _index: index,
      };
    });

    const dishDedup = await dedupeSimilarDishes(scored, {
      language: normalizedLanguage,
      signal,
    });
    const dedupeDropped = dishDedup.dropped;
    const selected = selectDiverse(dishDedup.recipes, wanted).map((candidate) =>
      publicRecipe(candidate, {
        dishQuery: dish,
        language: normalizedLanguage,
        inventory: inventoryItems,
      })
    );

    // 6. The user set a language in the app; results must come back in it.
    //    An English page is translated before it is returned to a Chinese
    //    user, and vice versa. Best effort: failures keep the original text.
    const translatable = countTranslatableStrings(selected, normalizedLanguage);
    let returned = selected;
    if (
      translationEnabled &&
      typeof translate === "function" &&
      translatable > 0
    ) {
      try {
        const translated = await translate(selected, normalizedLanguage, {
          // Linked to the caller's signal rather than the pipeline deadline: a
          // slow search must not silently cancel the translation step, but a
          // disconnected client must still stop the work.
          signal,
        });
        const appliedCount = Array.isArray(translated)
          ? translated.filter((recipe) => recipe.translation).length
          : 0;
        if (Array.isArray(translated) && appliedCount > 0) {
          returned = translated;
          translation = {
            enabled: true,
            requested: translatable,
            applied: appliedCount,
            failed: 0,
          };
        } else {
          // Reported as a failure so a silent no-op is never mistaken for
          // "this page was already in the right language".
          translation = {
            enabled: true,
            requested: translatable,
            applied: 0,
            failed: 1,
          };
        }
      } catch {
        translation = {
          enabled: true,
          requested: translatable,
          applied: 0,
          failed: 1,
        };
      }
    } else {
      translation = {
        enabled: Boolean(translationEnabled),
        requested: translatable,
        applied: 0,
        failed: 0,
      };
    }

    if (selected.length === 0) {
      pushWarning(
        "NO_MATCHING_DISH",
        parsed.length === 0 ? messages.noStructured(dish) : messages.noDish(dish)
      );
    }

    return {
      recipes: returned,
      warnings: warnings.slice(0, 12),
      meta: {
        language: normalizedLanguage,
        dishQuery: dish,
        queries,
        queriesRun,
        pagesConsidered: pages.length,
        hostFilter: {
          enabled: Array.isArray(deniedHosts) && deniedHosts.length > 0,
          resultsSkipped: skippedHostResults,
          hostsSkipped: [...skippedHosts],
        },
        pagesFetched: parsedPages.filter(Boolean).length,
        candidatesParsed: parsed.length,
        candidatesAfterConstraints: safe.length,
        dishGate: gateCounts,
        minimumVerdict,
        aliases: {
          source: aliasExpansion,
          names: aliasesUsed,
        },
        ingredients: {
          terms: termSet.length,
          extraVariants: variantCount,
          derivativeExclusions: exclusionCount,
          serviceExpanded: Object.keys(variantTable).length > 0,
        },
        translation: {
          enabled: Boolean(translationEnabled),
          requested: translation.requested,
          applied: translation.applied,
          failed: translation.failed,
        },
        dedupe: {
          nearDuplicateDropped: dedupeDropped,
        },
        applied: {
          energyPreference: energy,
          maxCaloriesPerServing: calorieCeiling,
          maxPrepMinutes: timeCeiling,
          maxIngredients: ingredientCeiling,
          preferredCuisines: cuisines,
          dislikedIngredientCount: dislikes.length,
          mealType: mealTypeBucket,
          servings: boundedInteger(servings, { min: 1, max: 12 }),
          inventoryItemCount: inventoryItems.length,
        },
        returnedCount: returned.length,
      },
    };
  } finally {
    deadline.cleanup();
  }
}

/**
 * Single entry point for callers: use the dish pipeline when the model sent a
 * dishQuery, otherwise fall back to the existing inventory engine untouched.
 */
export async function searchRecipesWithDish(
  overrides = {},
  recipeContext = {},
  deps = {}
) {
  const dishQuery = String(
    overrides?.dishQuery ?? recipeContext?.dishQuery ?? ""
  ).trim();
  if (!dishQuery) {
    const { recommendRecipes } = await import("./recipeRecommendations.js");
    return recommendRecipes(overrides, recipeContext, deps);
  }
  const saved = recipeContext?.preferences?.explicit || {};
  return searchRecipesByDish(
    {
      dishQuery,
      language: deps.language ?? recipeContext?.language ?? "en",
      deniedHosts: deps.deniedHosts,
      limits: deps.limits,
      aliases: deps.aliases,
      inventory: (recipeContext?.inventory || []).map((item) =>
        typeof item === "string" ? item : item?.name
      ).filter(Boolean),
      resultCount: overrides?.resultCount,
      // Current-turn constraints from the model win over saved defaults, the
      // same precedence the inventory engine uses.
      mealType: overrides?.mealType ?? null,
      energyPreference:
        overrides?.energyPreference ?? saved.preferredEnergy ?? "any",
      maxCaloriesPerServing:
        overrides?.maxCaloriesPerServing ?? saved.maxCaloriesPerServing ?? null,
      maxPrepMinutes: overrides?.maxPrepMinutes ?? saved.maxPrepMinutes ?? null,
      maxIngredients: overrides?.maxIngredients ?? null,
      servings: overrides?.servings ?? saved.defaultServings ?? null,
      preferredCuisines: [
        ...(overrides?.preferredCuisines || []),
        ...(saved.preferredCuisines || []),
      ],
      dislikedIngredients: saved.dislikedIngredients || [],
      allergens: saved.allergens || [],
      excludedIngredients: [
        ...(saved.excludedIngredients || []),
        ...(overrides?.excludedIngredients || []),
      ],
      dietaryPatterns: [
        ...(saved.dietaryPatterns || []),
        ...(overrides?.dietaryPatterns || []),
      ],
      signal: deps.signal,
    },
    {
      search: deps.search,
      fetchPage: deps.fetchPage,
      expandDish: deps.expandDish,
      expandIngredients: deps.expandIngredients,
      translate: deps.translate,
      translationEnabled: deps.translationEnabled,
      aliasExpansionEnabled: deps.aliasExpansionEnabled,
    }
  );
}
