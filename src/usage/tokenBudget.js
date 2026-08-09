// src/usage/tokenBudget.js

export const DAILY_TOKEN_LIMIT_REACHED_MESSAGE =
  "Daily token limit reached. Please try again after the quota resets.";

export const REQUEST_EXCEEDS_TOKEN_BUDGET_MESSAGE =
  "This request is too large for the remaining daily token budget.";

// Serialized text/tool payloads are converted to a conservative token estimate
// using a calibrated UTF-8 byte ratio. Provider-reported usage remains the
// authoritative value when a reservation is reconciled.
const TEXT_BYTES_PER_RESERVED_TOKEN = 3;
const TOKENS_PER_MESSAGE = 8;
const RESPONSE_PRIMER_TOKENS = 16;
const IMAGE_INPUT_TOKEN_RESERVATION = 4_096;
const AUDIO_BYTES_PER_RESERVED_TOKEN = 64;
const AUDIO_TOKEN_RESERVATION_OVERHEAD = 256;

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }

  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }

  return value;
}

function normalizePayloadForBudget(value, seen, counters) {
  if (value == null) return value;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value !== "object") return null;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (
    !Array.isArray(value) &&
    value.type === "image_url" &&
    value.image_url &&
    typeof value.image_url === "object"
  ) {
    counters.images += 1;
    const normalizedImagePart = {
      ...value,
      image_url: {
        ...value.image_url,
        // Full camera data URLs are transport encoding, not text input tokens.
        url: "[image omitted from text-token reservation]",
      },
    };
    seen.delete(value);
    return normalizedImagePart;
  }

  let normalized;

  if (Array.isArray(value)) {
    normalized = value.map((item) =>
      normalizePayloadForBudget(item, seen, counters)
    );
  } else {
    normalized = {};
    for (const [key, childValue] of Object.entries(value)) {
      normalized[key] = normalizePayloadForBudget(
        childValue,
        seen,
        counters
      );
    }
  }

  seen.delete(value);
  return normalized;
}

/**
 * Provides a conservative reservation for Chat Completions messages. Text and
 * tool payloads use a conservative serialized UTF-8 byte ratio, while image inputs get
 * a fixed vision reservation instead of counting a base64 data URL as text.
 * Provider-reported total_tokens remains the authoritative final accounting.
 */
export function estimateTokensFromMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new TypeError("messages must be an array.");
  }

  if (messages.length === 0) return 0;

  const counters = { images: 0 };
  const normalizedPayload = normalizePayloadForBudget(
    messages,
    new Set(),
    counters
  );
  const serializedPayload = JSON.stringify(normalizedPayload);
  const textTokenReservation = Math.ceil(
    Buffer.byteLength(serializedPayload, "utf8") /
      TEXT_BYTES_PER_RESERVED_TOKEN
  );

  return (
    textTokenReservation +
    counters.images * IMAGE_INPUT_TOKEN_RESERVATION +
    messages.length * TOKENS_PER_MESSAGE +
    RESPONSE_PRIMER_TOKENS
  );
}

/**
 * Reserves transcription capacity before the provider call. Audio endpoints do
 * not expose a max-token request option, so free-user uploads must fit this
 * deliberately conservative byte-based bound instead.
 */
export function estimateAudioTokensFromBytes(fileBytes) {
  const normalizedFileBytes = requirePositiveInteger(fileBytes, "fileBytes");

  return (
    Math.ceil(normalizedFileBytes / AUDIO_BYTES_PER_RESERVED_TOKEN) +
    AUDIO_TOKEN_RESERVATION_OVERHEAD
  );
}

/**
 * Computes the unused portion of a daily quota without returning negatives.
 */
export function computeRemainingTokens(tokensUsed, dailyLimit) {
  const normalizedTokensUsed = requireNonNegativeInteger(tokensUsed, "tokensUsed");
  const normalizedDailyLimit = requirePositiveInteger(dailyLimit, "dailyLimit");

  return Math.max(0, normalizedDailyLimit - normalizedTokensUsed);
}

/**
 * Computes the completion allowance for one request.
 *
 * The returned field names intentionally match the existing WebSocket budget
 * payload, which keeps this pure helper easy to adopt without protocol changes.
 */
export function computeTokenBudget({
  tokensUsed,
  dailyLimit,
  maxCompletionTokens,
  messages,
}) {
  const normalizedMaxCompletionTokens = requirePositiveInteger(
    maxCompletionTokens,
    "maxCompletionTokens"
  );
  const remainingTokens = computeRemainingTokens(tokensUsed, dailyLimit);

  if (remainingTokens === 0) {
    return {
      ok: false,
      reason: DAILY_TOKEN_LIMIT_REACHED_MESSAGE,
      remainingTokens,
    };
  }

  const estPromptTokens = estimateTokensFromMessages(messages);

  if (estPromptTokens >= remainingTokens) {
    return {
      ok: false,
      reason: REQUEST_EXCEEDS_TOKEN_BUDGET_MESSAGE,
      remainingTokens,
      estPromptTokens,
    };
  }

  return {
    ok: true,
    remainingTokens,
    estPromptTokens,
    maxCompletionTokens: Math.min(
      normalizedMaxCompletionTokens,
      remainingTokens - estPromptTokens
    ),
  };
}
