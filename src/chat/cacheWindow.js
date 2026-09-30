// src/chat/cacheWindow.js
//
// Diagnostics only. Tracks when each user last issued a Pantrio AI request so
// the opt-in request log can say whether the prompt cache's 30-minute window
// was still open, or had expired since the previous turn.
//
// This exists because a `cachedTokens: 0` line is ambiguous on its own: it can
// mean the prefix missed, or that there was nothing cached yet. Pairing it with
// the gap since the previous request is what makes the number interpretable.
//
// State is in-memory and bounded: it is a diagnostic signal, not accounting, so
// losing it on restart is fine. Nothing here throws or awaits.

export const CACHE_TTL_MS = 30 * 60 * 1000;

// Bounded so a long-lived process cannot grow this without limit; insertion
// order is refreshed on every touch, so the oldest idle user is evicted first.
export const MAX_TRACKED_USERS = 5_000;

const lastSeenAt = new Map();

/**
 * Records this request and reports the gap since the same user's previous one.
 * `previousRequestAgeMs` and `cacheWindowExpired` are null on a user's first
 * request, where there is no prior window to measure.
 */
export function noteRequest(uid, now = Date.now()) {
  const key = typeof uid === "string" ? uid : "";
  if (!key) return { previousRequestAgeMs: null, cacheWindowExpired: null };

  const previous = lastSeenAt.get(key);
  if (previous !== undefined) lastSeenAt.delete(key);
  lastSeenAt.set(key, now);

  while (lastSeenAt.size > MAX_TRACKED_USERS) {
    const oldest = lastSeenAt.keys().next().value;
    if (oldest === undefined) break;
    lastSeenAt.delete(oldest);
  }

  if (!Number.isFinite(previous)) {
    return { previousRequestAgeMs: null, cacheWindowExpired: null };
  }

  const age = Math.max(0, now - previous);
  return { previousRequestAgeMs: age, cacheWindowExpired: age > CACHE_TTL_MS };
}

/** Test helper: forget all tracked users. */
export function resetCacheWindow() {
  lastSeenAt.clear();
}

/** Test helper: how many users are currently tracked. */
export function trackedUserCount() {
  return lastSeenAt.size;
}
