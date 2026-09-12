// bench/dishSearchBenchmark.mjs
//
// A/B harness: the existing inventory engine (recommendRecipes) versus the new
// dish pipeline (searchRecipesByDish), run on the same scenarios with the same
// fridge inventory and result count.
//
// This is deliberately NOT a unit test. It performs live searches and page
// fetches, so it lives outside test/ and is never picked up by `npm test`.
//
//   node bench/dishSearchBenchmark.mjs
//
// Scoring uses a per-scenario `judge` written by hand from the dish itself.
// The judge is independent of the dish gate, so it can disagree with the
// pipeline and expose a gate that is too strict or too loose.

import { recommendRecipes } from "../src/chat/recipeRecommendations.js";
import {
  recipeIdeationEnabled,
  generateRecipeIdeas,
} from "../src/chat/recipeIdeation.js";
import { TOOLS } from "../src/chat/tools.js";
import { searchRecipesByDish } from "../src/chat/recipeDishSearch.js";

const SCENARIOS = [
  {
    id: "tomato-egg-stir-fry/en",
    language: "en",
    dishQuery: "tomato egg stir fry",
    // What the model emits today for "how do i make tomato egg stirfry".
    originalOverrides: { mustUseIngredients: ["tomato", "egg"], resultCount: 3 },
    inventory: ["cucumber", "eggs"],
    // A stir fry, not a salad or a baked-egg dish that merely uses both.
    judge: (title) =>
      /tomato/i.test(title) && /egg/i.test(title) && /stir|fry|fried/i.test(title),
  },
  {
    id: "tomato-egg-stir-fry/zh",
    language: "zh-CN",
    dishQuery: "番茄炒蛋",
    originalOverrides: { mustUseIngredients: ["番茄", "鸡蛋"], resultCount: 3 },
    inventory: ["黄瓜", "鸡蛋"],
    judge: (title) =>
      (/番茄|tomato/i.test(title) &&
        (/蛋|egg/i.test(title)) &&
        (/炒|stir|fry|fried/i.test(title))),
  },
  {
    id: "mapo-tofu/en",
    language: "en",
    dishQuery: "mapo tofu",
    originalOverrides: { mustUseIngredients: ["tofu"], resultCount: 3 },
    inventory: ["tofu", "scallion", "rice"],
    judge: (title) => /mapo/i.test(title),
  },
  {
    id: "mapo-tofu/zh",
    language: "zh-CN",
    dishQuery: "麻婆豆腐",
    originalOverrides: { mustUseIngredients: ["豆腐"], resultCount: 3 },
    inventory: ["豆腐", "葱"],
    judge: (title) => /麻婆|mapo/i.test(title),
  },
];

function score(recipes, judge) {
  const titles = recipes.map((recipe) => recipe.title);
  const hits = titles.filter(judge).length;
  return {
    titles,
    hits,
    precision: titles.length ? hits / titles.length : null,
  };
}

async function runOriginal(scenario) {
  const started = Date.now();
  const result = await recommendRecipes(
    { ...scenario.originalOverrides },
    { inventory: scenario.inventory.map((name) => ({ name })) },
    {
      search: TOOLS.webSearch,
      ideate: generateRecipeIdeas,
      ideationEnabled: recipeIdeationEnabled(),
      estimationEnabled: false,
      estimateMeta: async () => ({ ok: true, estimatedCount: 0 }),
    }
  );
  return {
    ms: Date.now() - started,
    queriesRun: result.meta.queriesRun,
    pagesFetched: result.meta.pagesFetched,
    candidatesParsed: result.meta.candidatesParsed,
    ...score(result.recipes, scenario.judge),
    extras: {
      ideationIdeas: result.meta.ideation?.ideaCount ?? 0,
      relaxedRequired: result.meta.ideation?.ideaRelaxedRequired ?? false,
    },
  };
}

async function runDish(scenario) {
  const started = Date.now();
  const result = await searchRecipesByDish(
    {
      dishQuery: scenario.dishQuery,
      language: scenario.language,
      inventory: scenario.inventory,
      resultCount: scenario.originalOverrides.resultCount,
    },
    {}
  );
  return {
    ms: Date.now() - started,
    queriesRun: result.meta.queriesRun,
    pagesFetched: result.meta.pagesFetched,
    candidatesParsed: result.meta.candidatesParsed,
    ...score(result.recipes, scenario.judge),
    extras: {
      gate: result.meta.dishGate,
      skipped: result.meta.hostFilter.resultsSkipped,
      empty: result.recipes.length === 0,
    },
  };
}

const rows = [];
for (const scenario of SCENARIOS) {
  const original = await runOriginal(scenario);
  const dish = await runDish(scenario);
  rows.push({ scenario, original, dish });
  console.log(`\n### ${scenario.id}  (inventory: ${scenario.inventory.join(", ")})`);
  for (const [label, run] of [["original", original], ["dish", dish]]) {
    console.log(
      `  ${label.padEnd(9)} ${String(run.ms + "ms").padEnd(8)}` +
        ` queries=${run.queriesRun} fetched=${run.pagesFetched} parsed=${run.candidatesParsed}` +
        ` returned=${run.titles.length} hits=${run.hits}` +
        ` precision=${run.precision == null ? "n/a" : run.precision.toFixed(2)}`
    );
    for (const title of run.titles) {
      console.log(`      ${scenario.judge(title) ? "[hit ]" : "[miss]"} ${title}`);
    }
    if (label === "original") {
      console.log(
        `      extras: ideas=${run.extras.ideationIdeas} relaxedRequired=${run.extras.relaxedRequired}`
      );
    } else {
      console.log(
        `      extras: skipped=${run.extras.skipped} gate=${JSON.stringify(run.extras.gate)}`
      );
    }
  }
}

console.log("\n=== totals ===");
const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
console.log(
  "original: returned=%d hits=%d fetched=%d parsed=%d ms=%d",
  sum((r) => r.original.titles.length),
  sum((r) => r.original.hits),
  sum((r) => r.original.pagesFetched),
  sum((r) => r.original.candidatesParsed),
  sum((r) => r.original.ms)
);
console.log(
  "dish:     returned=%d hits=%d fetched=%d parsed=%d ms=%d",
  sum((r) => r.dish.titles.length),
  sum((r) => r.dish.hits),
  sum((r) => r.dish.pagesFetched),
  sum((r) => r.dish.candidatesParsed),
  sum((r) => r.dish.ms)
);
console.log(
  "empty runs: original=%d dish=%d",
  rows.filter((r) => r.original.titles.length === 0).length,
  rows.filter((r) => r.dish.titles.length === 0).length
);
