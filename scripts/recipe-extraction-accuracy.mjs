#!/usr/bin/env node
// Accuracy harness for the unstructured recipe extractor (recipeTextExtract.js).
//
// This needs NETWORK ACCESS (to fetch real pages) and OPENAI_API_KEY (for the
// model extraction). It cannot run inside the sandbox; run it where both are
// available:
//
//   export OPENAI_API_KEY="..."
//   node scripts/recipe-extraction-accuracy.mjs --urls=./scripts/urls.txt
//   node scripts/recipe-extraction-accuracy.mjs --url=https://example.com/recipe --language=fr
//
// Input file format (one entry per line, blank lines and # comments ignored):
//   https://example.com/recipe
//   https://example.fr/recette|fr
//   https://example.jp/レシピ|ja
//
// Output is one JSON object per entry plus a final summary, so you can eyeball
// extraction quality per site/language and compute your own success rate.

import { readFile } from "node:fs/promises";
import { fetchPublicTextPage } from "../src/chat/safeWebFetch.js";
import {
  extractRecipesFromPage,
  looksLikeRecipePage,
  stripHtmlToText,
} from "../src/chat/recipeTextExtract.js";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
    else if (arg.startsWith("--")) args[arg.slice(2)] = true;
  }
  return args;
}

function parseEntries(text) {
  const entries = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [url, language] = line.split("|").map((part) => part.trim());
    if (url) entries.push({ url, language: language || "en" });
  }
  return entries;
}

function summarize(recipe) {
  if (!recipe) return null;
  return {
    title: recipe.title || "",
    ingredients: (recipe.ingredients || []).length,
    instructions: (recipe.instructions || []).length,
  };
}

const args = parseArgs(process.argv.slice(2));
const defaultLanguage = args.language || "en";

const entries = [];
if (args.url) {
  entries.push({ url: args.url, language: defaultLanguage });
} else if (args.urls) {
  entries.push(...parseEntries(await readFile(args.urls, "utf8")));
} else {
  console.error(
    "Provide --url=... or --urls=<file>. See the header comment for the format."
  );
  process.exit(2);
}

let gatePassed = 0;
let extracted = 0;
let failed = 0;

for (const entry of entries) {
  const started = Date.now();
  const record = {
    url: entry.url,
    language: entry.language,
    ok: false,
    gate: null,
    extracted: null,
    elapsedMs: 0,
    error: null,
  };

  try {
    const page = await fetchPublicTextPage(entry.url, {
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
    });
    record.gate = looksLikeRecipePage(page.text);
    if (record.gate) gatePassed += 1;

    const recipes = await extractRecipesFromPage(page.text, {
      pageUrl: page.url || entry.url,
      language: entry.language,
    });
    record.extracted = recipes.map(summarize);
    if (recipes.length > 0) extracted += 1;
    else failed += 1;
    record.ok = true;
  } catch (error) {
    failed += 1;
    record.error = error?.message || String(error);
  }

  record.elapsedMs = Date.now() - started;
  console.log(JSON.stringify(record));
}

console.log(
  JSON.stringify({
    summary: {
      total: entries.length,
      gatePassed,
      extracted,
      failed,
    },
  })
);
