// src/usage/quotaWindows.js
//
// Chooses which token window governs one request and reserves against it.
//
// A plan may carry a daily limit, a monthly limit, or both. When both exist the
// month governs; the day is a burst guard. When the month is spent the daily
// limit becomes a grace floor instead of a hard stop, so a paying customer is
// throttled rather than locked out until renewal.

import { dayKeyLA } from "../db/db.js";
import { NON_SUBSCRIBER_TOKENS_PER_DAY } from "../config/policy.js";
import { getNextQuotaResetAt } from "./quotaSnapshot.js";
import {
  QUOTA_TIMEZONE,
  getNextMonthResetAt,
  monthKeyLA,
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

/**
 * Read both windows and decide which one governs. Shared by the WebSocket
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

  return {
    dailyUsed: daily.tokens_used,
    monthUsed: monthly.tokens_used,
    window: resolveTokenWindow({
      plan,
      dailyUsed: daily.tokens_used,
      monthUsed: monthly.tokens_used,
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

/**
 * Resolve the window that governs this request.
 *
 * - monthly plan with room, daily guard not exceeded -> month
 * - monthly plan with room, daily guard exceeded    -> day (remaining 0)
 * - monthly plan spent                              -> day, grace floor
 * - no monthly plan                                 -> day
 * - no limits at all                                -> { applies: false }
 */
export function resolveTokenWindow({
  plan,
  dailyUsed = 0,
  monthUsed = 0,
  now = new Date(),
}) {
  const dailyLimit = positiveLimit(plan?.dailyTokenLimit);
  const monthlyLimit = positiveLimit(plan?.monthlyTokenLimit);

  if (monthlyLimit === null) {
    return dailyLimit === null
      ? { applies: false, kind: null, grace: false, limit: null, used: 0, remaining: null, windowKey: null, resetsAt: getNextQuotaResetAt(now), timezone: QUOTA_TIMEZONE }
      : dayWindow(dailyLimit, dailyUsed, { grace: false, now });
  }

  const monthRemaining = computeRemainingTokens(monthUsed, monthlyLimit);

  if (monthRemaining > 0) {
    if (dailyLimit !== null && dailyUsed >= dailyLimit) {
      return dayWindow(dailyLimit, dailyUsed, { grace: false, now });
    }
    return monthWindow(monthlyLimit, monthUsed, { grace: false, now });
  }

  // Monthly allowance spent: continue on the free daily allowance.
  if (dailyLimit === null) {
    return monthWindow(monthlyLimit, monthUsed, { grace: false, now });
  }

  // Grace is the FREE daily allowance, not the paid burst limit. Using the
  // paid 500k here would hand back roughly another month of usage.
  const graceLimit = Math.min(dailyLimit, NON_SUBSCRIBER_TOKENS_PER_DAY);
  return dayWindow(graceLimit, dailyUsed, { grace: true, now });
}

/** Reserve against the governing window. Returns null when it is full. */
export async function reserveTokenWindow(
  db,
  ownerType,
  ownerKey,
  window,
  reserveTokens
) {
  if (window?.kind === "month") {
    return reservePeriodUsage(
      db,
      ownerType,
      ownerKey,
      window.windowKey,
      reserveTokens,
      window.limit
    );
  }
  return reserveUsage(db, ownerType, ownerKey, reserveTokens, window.limit);
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
  if (reservation?.windowKind === "month") {
    const row = await reconcilePeriodReservation(
      db,
      ownerType,
      ownerKey,
      reservation,
      actualTokens,
      addRequests
    );
    // Mirror the settled amount into today's row so the burst guard and the
    // grace floor see paid usage. This is a positive add, not the month's
    // adjustment: the month row already holds the reservation, while the daily
    // row starts empty and should end at the actual total. When the provider
    // never reported usage, keep the reservation as the estimate.
    const settledTokens =
      actualTokens === null ? reservation.tokens : actualTokens;
    await adjustDailyUsage(db, ownerType, ownerKey, settledTokens, addRequests);
    return row;
  }
  return reconcileUsageReservation(
    db,
    ownerType,
    ownerKey,
    reservation,
    actualTokens,
    addRequests
  );
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

  if (window?.kind === "month") {
    const row = await addPeriodUsage(
      db,
      ownerType,
      ownerKey,
      "month",
      window.windowKey,
      actualTokens,
      addRequests
    );
    await adjustDailyUsage(db, ownerType, ownerKey, actualTokens, addRequests);
    return row;
  }
  return addUsage(db, ownerType, ownerKey, actualTokens, addRequests);
}

/**
 * Shape a resolved window for the session and error payloads. Mirrors the
 * existing createQuotaSnapshot fields so older clients keep working, and adds
 * the window name so newer ones can say "monthly" or "today".
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
