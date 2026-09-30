// src/chat/usageShape.js
//
// One normalized token shape for both transports, so quota accounting and the
// opt-in diagnostics never depend on which endpoint produced the number:
//   Chat Completions: prompt_tokens / completion_tokens / *_details
//   Responses:        input_tokens / output_tokens / *_details

function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Normalize provider usage onto the Chat Completions field names the gateway
 * already accounts with, keeping the reasoning and cache counters.
 * Returns null when the payload has no usable total.
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage.total_tokens !== "number") return null;
  return {
    prompt_tokens: toCount(usage.prompt_tokens ?? usage.input_tokens),
    completion_tokens: toCount(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: toCount(usage.total_tokens),
    reasoning_tokens: toCount(
      usage.completion_tokens_details?.reasoning_tokens ??
        usage.output_tokens_details?.reasoning_tokens
    ),
    cached_tokens: toCount(
      usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens
    ),
  };
}

/** Cached share of the prompt, rounded, or 0 when the prompt is empty. */
export function cacheHitRatio(usage) {
  const prompt = toCount(usage?.prompt_tokens);
  if (!prompt) return 0;
  return Number((toCount(usage?.cached_tokens) / prompt).toFixed(4));
}
