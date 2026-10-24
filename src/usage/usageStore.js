// src/usage/usageStore.js
import { dayKeyLA } from "../db/db.js";

export function parseOwner(userId, isAuthed) {
  if (isAuthed) return { ownerType: "user", ownerKey: userId };
  const ownerKey = String(userId).startsWith("trial:") ? userId.slice(6) : userId;
  return { ownerType: "trial", ownerKey };
}

export async function getUsageRow(db, ownerType, ownerKey) {
  const day = dayKeyLA();
  const row = await db.get(
    `SELECT tokens_used, requests
       FROM usage_daily
      WHERE owner_type=? AND owner_key=? AND day_key=?`,
    [ownerType, ownerKey, day]
  );

  return row || { tokens_used: 0, requests: 0 };
}

export async function addUsage(db, ownerType, ownerKey, addTokens, addRequests = 0) {
  const day = dayKeyLA();
  const now = Date.now();

  return db.get(
    `
    INSERT INTO usage_daily (owner_type, owner_key, day_key, tokens_used, requests, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_key, day_key)
    DO UPDATE SET
      tokens_used = tokens_used + excluded.tokens_used,
      requests = requests + excluded.requests,
      updated_at = excluded.updated_at
    RETURNING tokens_used, requests
    `,
    [ownerType, ownerKey, day, addTokens, addRequests, now]
  );
}

/**
 * Atomically reserves a request's estimated upper bound before contacting the
 * model provider. This prevents concurrent free requests from all passing the
 * same read-before-write quota check.
 */
export async function reserveUsage(
  db,
  ownerType,
  ownerKey,
  reserveTokens,
  dailyLimit
) {
  if (!Number.isInteger(reserveTokens) || reserveTokens <= 0) {
    throw new RangeError("reserveTokens must be a positive integer");
  }

  if (!Number.isInteger(dailyLimit) || dailyLimit <= 0) {
    throw new RangeError("dailyLimit must be a positive integer");
  }

  if (reserveTokens > dailyLimit) return false;

  const day = dayKeyLA();
  const now = Date.now();
  const row = await db.get(
    `
    INSERT INTO usage_daily (owner_type, owner_key, day_key, tokens_used, requests, updated_at)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(owner_type, owner_key, day_key)
    DO UPDATE SET
      tokens_used = usage_daily.tokens_used + excluded.tokens_used,
      updated_at = excluded.updated_at
    WHERE usage_daily.tokens_used + excluded.tokens_used <= ?
    RETURNING tokens_used, requests
    `,
    [ownerType, ownerKey, day, reserveTokens, now, dailyLimit]
  );

  return row
    ? {
        tokens: reserveTokens,
        dayKey: day,
        tokensUsed: row.tokens_used,
        requests: row.requests,
      }
    : null;
}

/**
 * Replaces a prior reservation with provider-reported usage. Passing null for
 * actualTokens deliberately keeps the reservation (for example, when an
 * interrupted stream never delivers its final usage chunk).
 */
export async function reconcileUsageReservation(
  db,
  ownerType,
  ownerKey,
  reservation,
  actualTokens,
  addRequests = 1
) {
  const reservedTokens = reservation?.tokens;
  const reservedDay = reservation?.dayKey;

  if (!Number.isInteger(reservedTokens) || reservedTokens <= 0) {
    throw new RangeError("reservation.tokens must be a positive integer");
  }

  if (typeof reservedDay !== "string" || !reservedDay) {
    throw new TypeError("reservation.dayKey must be a non-empty string");
  }

  if (
    actualTokens !== null &&
    (!Number.isInteger(actualTokens) || actualTokens < 0)
  ) {
    throw new RangeError("actualTokens must be null or a non-negative integer");
  }

  if (!Number.isInteger(addRequests) || addRequests < 0) {
    throw new RangeError("addRequests must be a non-negative integer");
  }

  const now = Date.now();
  const adjustment =
    actualTokens === null ? 0 : actualTokens - reservedTokens;
  const row = await db.get(
    `UPDATE usage_daily
        SET tokens_used = MAX(0, tokens_used + ?),
            requests = requests + ?,
            updated_at = ?
      WHERE owner_type = ?
        AND owner_key = ?
        AND day_key = ?
      RETURNING tokens_used, requests`,
    [adjustment, addRequests, now, ownerType, ownerKey, reservedDay]
  );

  if (!row) {
    throw new Error("Usage reservation was not found for reconciliation");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Longer windows and counted actions
// ---------------------------------------------------------------------------

/**
 * Token totals for a window longer than a day. Returns zeros when the window
 * has no row yet, mirroring getUsageRow().
 */
export async function getPeriodUsage(
  db,
  ownerType,
  ownerKey,
  windowKind,
  windowKey
) {
  const row = await db.get(
    `SELECT tokens_used, requests
       FROM usage_periods
      WHERE owner_type=? AND owner_key=? AND window_kind=? AND window_key=?`,
    [ownerType, ownerKey, windowKind, windowKey]
  );

  return row || { tokens_used: 0, requests: 0 };
}

/**
 * Atomically reserves against a monthly token window. Same conditional-upsert
 * shape as reserveUsage(), so concurrent requests cannot all pass a stale read.
 */
export async function reservePeriodUsage(
  db,
  ownerType,
  ownerKey,
  windowKey,
  reserveTokens,
  monthlyLimit
) {
  if (!Number.isInteger(reserveTokens) || reserveTokens <= 0) {
    throw new RangeError("reserveTokens must be a positive integer");
  }

  if (!Number.isInteger(monthlyLimit) || monthlyLimit <= 0) {
    throw new RangeError("monthlyLimit must be a positive integer");
  }

  if (typeof windowKey !== "string" || !windowKey) {
    throw new TypeError("windowKey must be a non-empty string");
  }

  if (reserveTokens > monthlyLimit) return false;

  const now = Date.now();
  const row = await db.get(
    `
    INSERT INTO usage_periods
      (owner_type, owner_key, window_kind, window_key, tokens_used, requests, updated_at)
    VALUES (?, ?, 'month', ?, ?, 0, ?)
    ON CONFLICT(owner_type, owner_key, window_kind, window_key)
    DO UPDATE SET
      tokens_used = usage_periods.tokens_used + excluded.tokens_used,
      updated_at = excluded.updated_at
    WHERE usage_periods.tokens_used + excluded.tokens_used <= ?
    RETURNING tokens_used, requests
    `,
    [ownerType, ownerKey, windowKey, reserveTokens, now, monthlyLimit]
  );

  return row
    ? {
        windowKind: "month",
        windowKey,
        tokens: reserveTokens,
        tokensUsed: row.tokens_used,
        requests: row.requests,
      }
    : null;
}

/** Adjusts a monthly reservation to provider-reported usage. */
export async function reconcilePeriodReservation(
  db,
  ownerType,
  ownerKey,
  reservation,
  actualTokens,
  addRequests = 1
) {
  const reservedTokens = reservation?.tokens;
  const reservedKey = reservation?.windowKey;

  if (!Number.isInteger(reservedTokens) || reservedTokens <= 0) {
    throw new RangeError("reservation.tokens must be a positive integer");
  }
  if (typeof reservedKey !== "string" || !reservedKey) {
    throw new TypeError("reservation.windowKey must be a non-empty string");
  }
  if (
    actualTokens !== null &&
    (!Number.isInteger(actualTokens) || actualTokens < 0)
  ) {
    throw new RangeError("actualTokens must be null or a non-negative integer");
  }

  const adjustment =
    actualTokens === null ? 0 : actualTokens - reservedTokens;
  const row = await db.get(
    `UPDATE usage_periods
        SET tokens_used = MAX(0, tokens_used + ?),
            requests = requests + ?,
            updated_at = ?
      WHERE owner_type = ?
        AND owner_key = ?
        AND window_kind = 'month'
        AND window_key = ?
      RETURNING tokens_used, requests`,
    [adjustment, addRequests, Date.now(), ownerType, ownerKey, reservedKey]
  );

  if (!row) {
    throw new Error("Period reservation was not found for reconciliation");
  }
  return row;
}

/**
 * Adds provider usage to a window without a prior reservation. Used by model
 * rounds after round 0, whose cost was not covered by the opening estimate.
 */
export async function addPeriodUsage(
  db,
  ownerType,
  ownerKey,
  windowKind,
  windowKey,
  addTokens,
  addRequests = 0
) {
  if (!Number.isInteger(addTokens) || addTokens < 0) {
    throw new RangeError("addTokens must be a non-negative integer");
  }
  if (!Number.isInteger(addRequests) || addRequests < 0) {
    throw new RangeError("addRequests must be a non-negative integer");
  }

  return db.get(
    `
    INSERT INTO usage_periods
      (owner_type, owner_key, window_kind, window_key, tokens_used, requests, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_key, window_kind, window_key)
    DO UPDATE SET
      tokens_used = usage_periods.tokens_used + excluded.tokens_used,
      requests = usage_periods.requests + excluded.requests,
      updated_at = excluded.updated_at
    RETURNING tokens_used, requests
    `,
    [ownerType, ownerKey, windowKind, windowKey, addTokens, addRequests, Date.now()]
  );
}

/** Current count for a counted action, or 0 when the window has no row. */
export async function getActionCount(
  db,
  ownerType,
  ownerKey,
  windowKind,
  windowKey,
  action
) {
  const row = await db.get(
    `SELECT count
       FROM usage_actions
      WHERE owner_type=? AND owner_key=? AND window_kind=?
        AND window_key=? AND action=?`,
    [ownerType, ownerKey, windowKind, windowKey, action]
  );

  return Number.isInteger(row?.count) ? row.count : 0;
}

/**
 * Atomically consumes one unit of a counted action. Returns the new count, or
 * null when the limit is already reached — the caller turns that into a
 * refusal. `limit === null` means unlimited but still metered.
 */
export async function consumeAction(
  db,
  ownerType,
  ownerKey,
  windowKind,
  windowKey,
  action,
  limit
) {
  if (typeof windowKey !== "string" || !windowKey) {
    throw new TypeError("windowKey must be a non-empty string");
  }

  const now = Date.now();

  if (limit === null) {
    const row = await db.get(
      `
      INSERT INTO usage_actions
        (owner_type, owner_key, window_kind, window_key, action, count, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(owner_type, owner_key, window_kind, window_key, action)
      DO UPDATE SET
        count = usage_actions.count + 1,
        updated_at = excluded.updated_at
      RETURNING count
      `,
      [ownerType, ownerKey, windowKind, windowKey, action, now]
    );
    return row?.count ?? 1;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer or null");
  }

  const row = await db.get(
    `
    INSERT INTO usage_actions
      (owner_type, owner_key, window_kind, window_key, action, count, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(owner_type, owner_key, window_kind, window_key, action)
    DO UPDATE SET
      count = usage_actions.count + 1,
      updated_at = excluded.updated_at
    WHERE usage_actions.count + 1 <= ?
    RETURNING count
    `,
    [ownerType, ownerKey, windowKind, windowKey, action, now, limit]
  );

  return row ? row.count : null;
}

/** Returns a consumed unit after a failed recommendation. Never throws. */
export async function releaseAction(
  db,
  ownerType,
  ownerKey,
  windowKind,
  windowKey,
  action
) {
  try {
    return await db.get(
      `UPDATE usage_actions
          SET count = MAX(0, count - 1),
              updated_at = ?
        WHERE owner_type = ? AND owner_key = ? AND window_kind = ?
          AND window_key = ? AND action = ?
        RETURNING count`,
      [Date.now(), ownerType, ownerKey, windowKind, windowKey, action]
    );
  } catch {
    return null;
  }
}

/**
 * Mirrors a usage delta into today's row without enforcing a limit.
 *
 * A paid request reserves the monthly window, but the daily row is still what
 * an optional burst guard and the monthly grace floor read. Without this
 * mirror, both would see zero paid usage.
 */
export async function adjustDailyUsage(
  db,
  ownerType,
  ownerKey,
  deltaTokens,
  addRequests = 0
) {
  if (!Number.isInteger(deltaTokens)) {
    throw new RangeError("deltaTokens must be an integer");
  }
  if (!Number.isInteger(addRequests) || addRequests < 0) {
    throw new RangeError("addRequests must be a non-negative integer");
  }
  if (deltaTokens === 0 && addRequests === 0) {
    return null;
  }

  const day = dayKeyLA();
  return db.get(
    `
    INSERT INTO usage_daily
      (owner_type, owner_key, day_key, tokens_used, requests, updated_at)
    VALUES (?, ?, ?, MAX(0, ?), ?, ?)
    ON CONFLICT(owner_type, owner_key, day_key)
    DO UPDATE SET
      tokens_used = MAX(0, usage_daily.tokens_used + excluded.tokens_used),
      requests = usage_daily.requests + excluded.requests,
      updated_at = excluded.updated_at
    RETURNING tokens_used, requests
    `,
    [ownerType, ownerKey, day, deltaTokens, addRequests, Date.now()]
  );
}
