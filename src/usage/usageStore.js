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
