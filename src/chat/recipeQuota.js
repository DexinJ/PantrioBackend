// src/chat/recipeQuota.js
//
// One recipe recommendation is one unit, regardless of how many Serper queries
// or model rounds it runs. Both entry points (the REST route and the WebSocket
// recommendRecipes tool) go through withRecipeQuota() so they cannot drift.

import { dayKeyLA } from "../db/db.js";
import {
  FREE_RECIPES_PER_DAY,
  QUOTA_ENFORCEMENT_ENABLED,
} from "../config/policy.js";
import {
  QUOTA_TIMEZONE,
  getNextMonthResetAt,
  monthKeyLA,
} from "../usage/periodKeys.js";
import { getNextQuotaResetAt } from "../usage/quotaSnapshot.js";
import {
  consumeAction,
  getActionCount,
  releaseAction,
} from "../usage/usageStore.js";

export const RECIPE_ACTION = "recipe_recommendation";

export class RecipeQuotaExceededError extends Error {
  constructor({ window: windowKind, limit, resetsAt, grace = false }) {
    super(
      grace
        ? "Your monthly recipe allowance is used up. The free daily allowance resets tomorrow."
        : windowKind === "month"
          ? "The monthly recipe allowance is used up."
          : "The daily recipe allowance is used up."
    );
    this.name = "RecipeQuotaExceededError";
    this.code = "RECIPE_QUOTA_EXCEEDED";
    this.window = windowKind;
    this.limit = limit;
    this.resetsAt = resetsAt;
    this.grace = grace;
  }
}

function positiveOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Read-only window descriptors for /api/session. */
export async function getRecipeQuotaWindows(
  db,
  ownerType,
  ownerKey,
  plan,
  now = new Date()
) {
  const windows = [];
  const perDay = positiveOrNull(plan?.recipesPerDay);
  const perMonth = positiveOrNull(plan?.recipesPerMonth);
  const monthUsed =
    perMonth === null
      ? 0
      : await getActionCount(
          db,
          ownerType,
          ownerKey,
          "month",
          monthKeyLA(now),
          RECIPE_ACTION
        );
  // Once the paid monthly allowance is spent, the session must show the same
  // free daily floor that consumeRecipeUnit() enforces.
  const grace = perMonth !== null && monthUsed >= perMonth;
  const dayLimit = grace
    ? Math.min(perDay ?? FREE_RECIPES_PER_DAY, FREE_RECIPES_PER_DAY)
    : perDay;

  if (dayLimit !== null) {
    const used = await getActionCount(
      db,
      ownerType,
      ownerKey,
      "day",
      dayKeyLA(now),
      RECIPE_ACTION
    );
    windows.push({
      kind: "day",
      unit: RECIPE_ACTION,
      limit: dayLimit,
      used,
      remaining: Math.max(0, dayLimit - used),
      resetsAt: getNextQuotaResetAt(now),
      timezone: QUOTA_TIMEZONE,
      grace,
    });
  }

  if (perMonth !== null) {
    windows.push({
      kind: "month",
      unit: RECIPE_ACTION,
      limit: perMonth,
      used: monthUsed,
      remaining: Math.max(0, perMonth - monthUsed),
      resetsAt: getNextMonthResetAt(now),
      timezone: QUOTA_TIMEZONE,
      grace,
    });
  }

  return windows;
}

/**
 * Consume one recipe unit. Limits are enforced only when the global switch is
 * on; otherwise the counters still advance so usage data stays comparable.
 */
async function consumeRecipeUnit({ db, ownerType, ownerKey, plan, now }) {
  const dayKey = dayKeyLA(now);
  const monthKey = monthKeyLA(now);
  const perDay = positiveOrNull(plan?.recipesPerDay);
  const perMonth = positiveOrNull(plan?.recipesPerMonth);

  // A paid plan whose monthly allowance is spent continues on the free daily
  // allowance, mirroring the token grace floor. Locking a paying customer out
  // until renewal is a worse outcome than a few extra searches.
  let grace = false;
  if (QUOTA_ENFORCEMENT_ENABLED && perMonth !== null) {
    const monthUsed = await getActionCount(
      db,
      ownerType,
      ownerKey,
      "month",
      monthKey,
      RECIPE_ACTION
    );
    grace = monthUsed >= perMonth;
  }

  const dayLimit = QUOTA_ENFORCEMENT_ENABLED
    ? grace
      ? Math.min(perDay ?? FREE_RECIPES_PER_DAY, FREE_RECIPES_PER_DAY)
      : perDay
    : null;

  const dayCount = await consumeAction(
    db,
    ownerType,
    ownerKey,
    "day",
    dayKey,
    RECIPE_ACTION,
    dayLimit
  );
  if (dayCount === null) {
    throw new RecipeQuotaExceededError({
      window: grace ? "month" : "day",
      limit: grace ? perMonth : perDay,
      resetsAt: getNextQuotaResetAt(now),
      grace,
    });
  }

  // Grace consumes only the daily unit; the monthly counter is already full.
  if (!grace) {
    try {
      const monthCount = await consumeAction(
        db,
        ownerType,
        ownerKey,
        "month",
        monthKey,
        RECIPE_ACTION,
        QUOTA_ENFORCEMENT_ENABLED ? perMonth : null
      );
      if (monthCount === null) {
        throw new RecipeQuotaExceededError({
          window: "month",
          limit: perMonth,
          resetsAt: getNextMonthResetAt(now),
        });
      }
    } catch (error) {
      // Give the day unit back when the month refuses the request.
      await releaseAction(db, ownerType, ownerKey, "day", dayKey, RECIPE_ACTION);
      throw error;
    }
  }

  return { dayKey, monthKey, grace };
}

async function releaseRecipeUnit({ db, ownerType, ownerKey, reservation }) {
  if (!reservation) return;
  await Promise.all([
    releaseAction(
      db,
      ownerType,
      ownerKey,
      "day",
      reservation.dayKey,
      RECIPE_ACTION
    ),
    releaseAction(
      db,
      ownerType,
      ownerKey,
      "month",
      reservation.monthKey,
      RECIPE_ACTION
    ),
  ]);
}

/**
 * Run a recipe recommendation under the quota.
 *
 * `context` is `{ db, ownerType, ownerKey, plan }`. Missing context (helper
 * paths and unit tests that inject their own engine) runs unmetered.
 * A thrown engine error refunds the unit so a transient failure does not cost
 * the user a recommendation.
 */
export async function withRecipeQuota(context, run) {
  const { db, ownerType, ownerKey, plan } = context || {};

  if (!db || !ownerType || !ownerKey) return run();

  let reservation = null;
  try {
    reservation = await consumeRecipeUnit({
      db,
      ownerType,
      ownerKey,
      plan,
      now: new Date(),
    });
  } catch (error) {
    if (error instanceof RecipeQuotaExceededError) throw error;
    // Metering must never be the reason a recipe search fails.
    console.warn("[recipe quota] metering failed", {
      name: String(error?.name || "Error"),
    });
  }

  try {
    return await run();
  } catch (error) {
    await releaseRecipeUnit({ db, ownerType, ownerKey, reservation });
    throw error;
  }
}
