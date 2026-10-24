// src/usage/quotaWindows.js
//
// Chooses which token window governs one request and reserves against it.
//
// A plan may carry a daily, weekly, or monthly limit. A monthly plan may also
// carry an explicit legacy/custom daily burst guard. When the month is spent,
// every paid plan receives the same bounded daily grace allowance instead of
// being locked out until renewal.

import { dayKeyLA } from "../db/db.js";
import {
  PAID_MONTHLY_GRACE_TOKENS_PER_DAY,
} from "../config/policy.js";
import { getNextQuotaResetAt } from "./quotaSnapshot.js";
import {
  QUOTA_TIMEZONE,
  getNextMonthResetAt,
  getNextWeekResetAt,
  monthKeyLA,
  weekKeyLA,
} from "./periodKeys.js";
import { computeRemainingTokens } from "./tokenBudget.js";
import {
  adjustDailyUsage,
  addUsage,
  addPeriodUsage,
  getPeriodUsage,
  getUsageRow,
  reconcilePeriodReservation,
  reconcileUsageReservation,
  reservePeriodUsage,
  reserveUsage,
} from "./usageStore.js";

function positiveLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function planHasTokenQuota(plan) {
  return (
    positiveLimit(plan?.weeklyTokenLimit) !== null ||
    positiveLimit(plan?.monthlyTokenLimit) !== null ||
    positiveLimit(plan?.dailyTokenLimit) !== null
  );
}

/**
 * Read all token windows and decide which one governs. Shared by the WebSocket
 * gateway and the REST summarize route so the two cannot disagree.
 */
export async function loadTokenWindow(
  db,
  ownerType,
  ownerKey,
  plan,
  now = new Date()
) {
  const daily = await getUsageRow(db, ownerType, ownerKey);
  const monthly = positiveLimit(plan?.monthlyTokenLimit)
    ? await getPeriodUsage(db, ownerType, ownerKey, "month", monthKeyLA(now))
    : { tokens_used: 0 };
  const weekly = positiveLimit(plan?.weeklyTokenLimit)
    ? await getPeriodUsage(db, ownerType, ownerKey, "week", weekKeyLA(now))
    : { tokens_used: 0 };

  return {
    dailyUsed: daily.tokens_used,
    monthUsed: monthly.tokens_used,
    weekUsed: weekly.tokens_used,
    window: resolveTokenWindow({
      plan,
      dailyUsed: daily.tokens_used,
      monthUsed: monthly.tokens_used,
      weekUsed: weekly.tokens_used,
      now,
    }),
  };
}

function dayWindow(limit, used, { grace, now }) {
  return {
    applies: true,
    kind: "day",
    grace,
    limit,
    used,
    remaining: computeRemainingTokens(used, limit),
    windowKey: dayKeyLA(now),
    resetsAt: getNextQuotaResetAt(now),
    timezone: QUOTA_TIMEZONE,
  };
}

function monthWindow(limit, used, { grace, now }) {
  return {
    applies: true,
    kind: "month",
    grace,
    limit,
    used,
    remaining: computeRemainingTokens(used, limit),
    windowKey: monthKeyLA(now),
    resetsAt: getNextMonthResetAt(now),
    timezone: QUOTA_TIMEZONE,
  };
}

function weekWindow(limit, used, { now }) {
  return {
    applies: true,
    kind: "week",
    grace: false,
    limit,
    used,
    remaining: computeRemainingTokens(used, limit),
    windowKey: weekKeyLA(now),
    resetsAt: getNextWeekResetAt(now),
    timezone: QUOTA_TIMEZONE,
  };
}

/**
 * Resolve the window that governs this request.
 *
 * - monthly plan with room and no guard    -> month
 * - monthly plan with room and guard full  -> day burst window
 * - monthly plan spent                     -> day grace window
 * - no monthly plan, weekly limit          -> week
 * - no monthly or weekly plan              -> legacy daily or no quota
 */
export function resolveTokenWindow({
  plan,
  dailyUsed = 0,
  monthUsed = 0,
  weekUsed = 0,
  now = new Date(),
}) {
  const dailyLimit = positiveLimit(plan?.dailyTokenLimit);
  const weeklyLimit = positiveLimit(plan?.weeklyTokenLimit);
  const monthlyLimit = positiveLimit(plan?.monthlyTokenLimit);

  if (monthlyLimit !== null) {
    const monthRemaining = computeRemainingTokens(monthUsed, monthlyLimit);

    if (monthRemaining > 0) {
      if (dailyLimit !== null && dailyUsed >= dailyLimit) {
        return dayWindow(dailyLimit, dailyUsed, { grace: false, now });
      }
      return monthWindow(monthlyLimit, monthUsed, { grace: false, now });
    }

    // Monthly allowance spent: grant the paid grace floor regardless of
    // whether the plan has a burst guard. For custom plans whose guard is
    // lower than the standard grace floor, preserve the tighter value.
    const graceLimit =
      dailyLimit === null
        ? PAID_MONTHLY_GRACE_TOKENS_PER_DAY
        : Math.min(dailyLimit, PAID_MONTHLY_GRACE_TOKENS_PER_DAY);
    return dayWindow(graceLimit, dailyUsed, { grace: true, now });
  }

  if (weeklyLimit !== null) {
    return weekWindow(weeklyLimit, weekUsed, { now });
  }

  if (dailyLimit !== null) {
    return dayWindow(dailyLimit, dailyUsed, { grace: false, now });
  }

  return {
    applies: false,
    kind: null,
    grace: false,
    limit: null,
    used: 0,
    remaining: null,
    windowKey: null,
    resetsAt: getNextQuotaResetAt(now),
    timezone: QUOTA_TIMEZONE,
  };
}

/** Reserve against the governing window. Returns null when it is full. */
export async function reserveTokenWindow(
  db,
  ownerType,
  ownerKey,
  window,
  reserveTokens
) {
  if (window?.kind === "week" || window?.kind === "month") {
    return reservePeriodUsage(
      db,
      ownerType,
      ownerKey,
      window.kind,
      window.windowKey,
      reserveTokens,
      window.limit
    );
  }
  if (window?.kind === "day") {
    return reserveUsage(db, ownerType, ownerKey, reserveTokens, window.limit);
  }
  throw new RangeError("Unsupported token window");
}

/** Replace a reservation with provider-reported usage for that window. */
export async function reconcileTokenWindow(
  db,
  ownerType,
  ownerKey,
  window,
  reservation,
  actualTokens,
  addRequests = 1
) {
  if (
    reservation?.windowKind === "week" ||
    reservation?.windowKind === "month"
  ) {
    const row = await reconcilePeriodReservation(
      db,
      ownerType,
      ownerKey,
      reservation,
      actualTokens,
      addRequests
    );
    if (reservation.windowKind === "month") {
      // Paid monthly usage drives the optional burst guard and grace floor.
      // Weekly free usage remains in usage_periods only.
      const settledTokens =
        actualTokens === null ? reservation.tokens : actualTokens;
      await adjustDailyUsage(db, ownerType, ownerKey, settledTokens, addRequests);
    }
    return row;
  }
  if (reservation?.dayKey) {
    return reconcileUsageReservation(
      db,
      ownerType,
      ownerKey,
      reservation,
      actualTokens,
      addRequests
    );
  }
  throw new RangeError("Unsupported token reservation");
}

/**
 * Add usage for a model round that had no reservation of its own. Without this,
 * every tool-continuation round after round 0 is invisible to the quota, and a
 * nine-round recipe turn counts as one round's worth of tokens.
 */
export async function addTokenWindowUsage(
  db,
  ownerType,
  ownerKey,
  window,
  actualTokens,
  addRequests = 1
) {
  if (!Number.isInteger(actualTokens) || actualTokens < 0) return null;

  if (window?.kind === "week" || window?.kind === "month") {
    const row = await addPeriodUsage(
      db,
      ownerType,
      ownerKey,
      window.kind,
      window.windowKey,
      actualTokens,
      addRequests
    );
    if (window.kind === "month") {
      await adjustDailyUsage(db, ownerType, ownerKey, actualTokens, addRequests);
    }
    return row;
  }
  if (window?.kind === "day") {
    return addUsage(db, ownerType, ownerKey, actualTokens, addRequests);
  }
  throw new RangeError("Unsupported token window");
}

/**
 * Shape a resolved window for the session and error payloads. Mirrors the
 * existing createQuotaSnapshot fields so older clients keep working, and adds
 * the window name so newer ones can say "weekly", "monthly", or "today".
 */
export function quotaSnapshotForWindow(window) {
  if (!window?.applies) {
    return {
      applies: false,
      limit: null,
      used: 0,
      reserved: 0,
      remaining: null,
      timezone: window?.timezone || QUOTA_TIMEZONE,
      resetsAt: window?.resetsAt || getNextQuotaResetAt(new Date()),
    };
  }

  return {
    applies: true,
    limit: window.limit,
    used: window.used,
    reserved: 0,
    remaining: window.remaining,
    timezone: window.timezone,
    resetsAt: window.resetsAt,
    window: window.kind,
    grace: window.grace === true,
  };
}
