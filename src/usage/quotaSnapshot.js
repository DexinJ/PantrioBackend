import { NON_SUBSCRIBER_TOKENS_PER_DAY } from "../config/policy.js";
import { getUsageRow } from "./usageStore.js";
import { computeRemainingTokens } from "./tokenBudget.js";

export const QUOTA_TIMEZONE = "America/Los_Angeles";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function localParts(date) {
  return Object.fromEntries(
    dateTimeFormatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)])
  );
}

function timeZoneOffsetMs(date) {
  const parts = localParts(date);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return representedAsUtc - Math.trunc(date.getTime() / 1_000) * 1_000;
}

/** Return the next Los Angeles calendar-day boundary as an ISO timestamp. */
export function getNextQuotaResetAt(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const current = localParts(now);
  const nextLocalMidnight = Date.UTC(
    current.year,
    current.month - 1,
    current.day + 1
  );
  let resetMs = nextLocalMidnight;

  // Two passes handle an offset change between `now` and the next midnight.
  for (let index = 0; index < 2; index += 1) {
    resetMs = nextLocalMidnight - timeZoneOffsetMs(new Date(resetMs));
  }

  return new Date(resetMs).toISOString();
}

export function createQuotaSnapshot({
  applies,
  tokensUsed = 0,
  dailyLimit = NON_SUBSCRIBER_TOKENS_PER_DAY,
  now = new Date(),
}) {
  if (typeof applies !== "boolean") {
    throw new TypeError("applies must be a boolean");
  }

  if (!applies) {
    return {
      applies: false,
      limit: null,
      used: 0,
      reserved: 0,
      remaining: null,
      timezone: QUOTA_TIMEZONE,
      resetsAt: getNextQuotaResetAt(now),
    };
  }

  return {
    applies: true,
    limit: dailyLimit,
    used: tokensUsed,
    // The current schema atomically includes reservations in tokens_used.
    // It cannot separate in-flight reservations, so none are double-counted.
    reserved: 0,
    remaining: computeRemainingTokens(tokensUsed, dailyLimit),
    timezone: QUOTA_TIMEZONE,
    resetsAt: getNextQuotaResetAt(now),
  };
}

export async function getQuotaSnapshot(
  db,
  ownerType,
  ownerKey,
  applies,
  { dailyLimit = NON_SUBSCRIBER_TOKENS_PER_DAY, now = new Date() } = {}
) {
  const usage = applies
    ? await getUsageRow(db, ownerType, ownerKey)
    : { tokens_used: 0 };

  return createQuotaSnapshot({
    applies,
    tokensUsed: usage.tokens_used,
    dailyLimit,
    now,
  });
}

/** Compatibility fields for older clients while they adopt nested `quota`. */
export function quotaLegacyFields(quota) {
  return {
    dailyLimit: quota.limit,
    usedTokens: quota.used,
    remainingTokens: quota.remaining,
    resetsAt: quota.resetsAt,
  };
}
