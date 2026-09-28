// src/usage/serperUsageStore.js
//
// Serper (web search) metering.
//
// Structure only: nothing here enforces a limit, and no request is ever
// refused because of these numbers. The counters exist so a future quota
// decision can be made from real usage instead of guesses — web search is the
// one shared cost that every provider path spends (pantrio, a user's own API
// key, and Apple AI all search through our Serper key).
//
// Every write is best-effort: a metering failure must never fail a search.

import { dayKeyLA } from "../db/db.js";

export const SERPER_KINDS = Object.freeze([
  "recipe_dish",
  "recipe_inventory",
  "websearch_tool",
]);

const EMPTY_SNAPSHOT = Object.freeze({
  queries: 0,
  results: 0,
  recipe_dish: 0,
  recipe_inventory: 0,
  websearch_tool: 0,
});

function cleanOwner(ctx) {
  const ownerType = ctx?.ownerType === "user" ? "user" : ctx?.ownerType === "trial" ? "trial" : "";
  const ownerKey = typeof ctx?.ownerKey === "string" ? ctx.ownerKey.trim() : "";
  if (!ownerType || !ownerKey) return null;
  return { ownerType, ownerKey };
}

/**
 * True when the caller can be attributed. Search wrappers stay untouched when
 * it is false, so unit tests that inject a plain search function keep seeing
 * the exact function they passed.
 */
export function hasAttributableOwner(ctx) {
  // A store that cannot upsert is not worth wrapping a search for: keeping the
  // original function also keeps injected test doubles identity-comparable.
  return Boolean(
    cleanOwner(ctx) && typeof ctx?.db?.get === "function"
  );
}

function resultCountOf(response) {
  const results = response?.results;
  return Array.isArray(results) ? results.length : 0;
}

function kindOf(value) {
  return SERPER_KINDS.includes(value) ? value : "websearch_tool";
}

/**
 * Records one Serper query. `ctx` is either a tool context
 * (`{ db, ownerType, ownerKey }`) or a lighter object carrying the same three
 * fields. Returns the updated row, or null when the caller is not attributable
 * (for example a helper call that passed only a signal).
 */
export async function recordSerperUsage(
  ctx,
  response = {},
  kind = "websearch_tool"
) {
  const owner = cleanOwner(ctx);
  const db = ctx?.db;
  if (!owner || !db || typeof db.get !== "function") return null;

  const column = kindOf(kind);
  const results = resultCountOf(response);
  const now = Date.now();
  try {
    return await db.get(
      `
      INSERT INTO serper_usage_daily
        (owner_type, owner_key, day_key, queries, results,
         recipe_dish, recipe_inventory, websearch_tool, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_type, owner_key, day_key)
      DO UPDATE SET
        queries = serper_usage_daily.queries + 1,
        results = serper_usage_daily.results + excluded.results,
        recipe_dish = serper_usage_daily.recipe_dish + excluded.recipe_dish,
        recipe_inventory = serper_usage_daily.recipe_inventory + excluded.recipe_inventory,
        websearch_tool = serper_usage_daily.websearch_tool + excluded.websearch_tool,
        updated_at = excluded.updated_at
      RETURNING queries, results, recipe_dish, recipe_inventory, websearch_tool
      `,
      [
        owner.ownerType,
        owner.ownerKey,
        dayKeyLA(),
        results,
        column === "recipe_dish" ? 1 : 0,
        column === "recipe_inventory" ? 1 : 0,
        column === "websearch_tool" ? 1 : 0,
        now,
      ]
    );
  } catch {
    // Metering is never allowed to fail a search.
    return null;
  }
}

/** Today's counters for one owner, used by /api/session. Never throws. */
export async function getSerperUsageSnapshot(db, ownerType, ownerKey) {
  if (!db || typeof db.get !== "function") return { ...EMPTY_SNAPSHOT };
  if (!ownerType || !ownerKey) return { ...EMPTY_SNAPSHOT };
  try {
    const row = await db.get(
      `SELECT queries, results, recipe_dish, recipe_inventory, websearch_tool
         FROM serper_usage_daily
        WHERE owner_type=? AND owner_key=? AND day_key=?`,
      [ownerType, ownerKey, dayKeyLA()]
    );
    return row ? { ...row } : { ...EMPTY_SNAPSHOT };
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

/**
 * Wraps a search function so every query is metered with the caller's owner.
 * Recipe engines call `search(query, { signal })`, which carries no owner, so
 * the attribution has to be attached where the request context is known.
 */
export function withSerperMetering(search, ctx, kind) {
  if (typeof search !== "function") return search;
  if (!hasAttributableOwner(ctx)) return search;
  return async function meteredSearch(args, options) {
    let response;
    try {
      response = await search(args, options);
    } catch (error) {
      await recordSerperUsage(ctx, { error: true }, kind);
      throw error;
    }
    await recordSerperUsage(ctx, response, kind);
    return response;
  };
}
