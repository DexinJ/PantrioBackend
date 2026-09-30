// src/chat/recipeTrace.js
//
// Recipe diagnostics.
//
// Additive and gated by the existing LOG_AI_REQUESTS flag, so enabling it gives
// the AI transcript (aiRequestLog.js) plus these structured events, and leaving
// it off is a strict no-op. No event here changes behaviour, throws, or awaits.
//
// One user turn is one trace. On the WebSocket path the gateway's requestId is
// reused as the traceId, so `pantrio_ai_request` and these lines join on the
// same value; the REST path has no request id, so one is generated and echoed
// back to the client as `X-Recipe-Trace`.
//
// Every line is single-line JSON with a stable `event` name, so grepping works:
//   railway logs | Select-String '"event":"recipe_engine_decision"'

import { LOG_AI_REQUESTS } from "../config/env.js";
import { createHash } from "node:crypto";

// Bounds. A trace must never be able to grow a log line without limit, and it
// must never be able to flood a request's log output.
export const MAX_TRACE_EVENTS = 160;
export const MAX_TRACE_STRING = 300;
export const MAX_TRACE_ARRAY = 25;
export const MAX_TRACE_KEYS = 30;
export const MAX_TRACE_DEPTH = 3;

export function clip(value, maxLength = MAX_TRACE_STRING) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…[truncated]`;
}

/**
 * Bounds any value so a log line stays readable and small: strings are
 * truncated, arrays and objects are capped, and cycles cannot recurse forever.
 */
export function boundedValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === "string") return clip(value);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value);
  if (type === "function") return "[function]";
  if (type === "symbol") return String(value);
  if (depth >= MAX_TRACE_DEPTH) return "[deep]";
  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_TRACE_ARRAY)
      .map((entry) => boundedValue(entry, depth + 1));
    if (value.length > MAX_TRACE_ARRAY) {
      output.push(`…+${value.length - MAX_TRACE_ARRAY} more`);
    }
    return output;
  }
  if (type === "object") {
    const keys = Object.keys(value);
    const output = {};
    for (const key of keys.slice(0, MAX_TRACE_KEYS)) {
      output[key] = boundedValue(value[key], depth + 1);
    }
    if (keys.length > MAX_TRACE_KEYS) {
      output["…"] = `${keys.length - MAX_TRACE_KEYS} more keys`;
    }
    return output;
  }
  return clip(String(value));
}

/**
 * The exact shape of the dish argument, which is the single most useful fact in
 * a dish-search investigation: "the model never sent it" and "it arrived empty"
 * are different bugs, and `typeof` alone cannot tell them apart.
 */
export function dishQueryShape(value) {
  const type = value === null ? "null" : typeof value;
  const text = typeof value === "string" ? value.trim() : "";
  return {
    present: value !== undefined && value !== null,
    type,
    isNull: value === null,
    isBlankString: type === "string" && text === "",
    length: typeof value === "string" ? value.length : 0,
    value: text ? clip(text, 200) : "",
  };
}

/**
 * Stable pseudonym for an owner key. Support still needs to recognize "the same
 * account", but a raw Firebase uid in a log line is a durable identifier that
 * has no business living in an observability sink.
 */
export function ownerKeyHash(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Summarizes a model-supplied argument object without logging the whole thing. */
export function argsShape(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { keys: [], count: 0 };
  }
  const keys = Object.keys(args);
  return {
    count: keys.length,
    keys: keys.slice(0, MAX_TRACE_KEYS),
    mustUseIngredients: Array.isArray(args.mustUseIngredients)
      ? args.mustUseIngredients.length
      : 0,
    excludedIngredients: Array.isArray(args.excludedIngredients)
      ? args.excludedIngredients.length
      : 0,
    dishQuery: dishQueryShape(args.dishQuery),
  };
}

/** A no-op trace with the same call signature, used everywhere logging is off. */
export const noopRecipeTrace = () => {};
noopRecipeTrace.enabled = false;

/**
 * Builds a trace function bound to one turn.
 *
 * `enabled` and `logger` are overridable so tests can assert without env vars,
 * matching the convention in aiRequestLog.js.
 */
export function createRecipeTrace({
  traceId = "",
  requestId = "",
  path = "",
  userId = "",
  round = null,
  enabled = LOG_AI_REQUESTS,
  logger = console.log,
  maxEvents = MAX_TRACE_EVENTS,
} = {}) {
  if (!enabled) return noopRecipeTrace;
  const boundId = traceId || requestId || "";
  let emitted = 0;

  const recipeTrace = function recipeTrace(event, fields = {}) {
    if (emitted >= maxEvents) return;
    emitted += 1;
    try {
      logger(
        JSON.stringify({
          event: String(event || "recipe_event"),
          timestamp: new Date().toISOString(),
          traceId: boundId,
          requestId: requestId || boundId,
          path: path || "",
          userId: userId || "",
          ...(Number.isInteger(round) ? { round } : {}),
          ...boundedValue(fields, 0),
          ...(emitted === maxEvents
            ? { traceTruncatedAt: maxEvents }
            : {}),
        })
      );
    } catch {
      // Diagnostics must never break a recipe request.
    }
  };
  recipeTrace.enabled = true;
  recipeTrace.traceId = boundId;
  recipeTrace.requestId = requestId || boundId;
  recipeTrace.path = path || "";
  return recipeTrace;
}
