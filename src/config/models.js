// Central AI model configuration.
// Change these values to switch the model the backend uses for each role.
//
// Note: explicit prompt-cache breakpoints are gated separately in policy.js
// (EXPLICIT_CACHE_BREAKPOINT_MODELS). If you point a chat model at a
// non-GPT-5.6 model, update that allowlist to match.

// Interactive chat (WebSocket) models.
export const CHAT_MODEL_FREE = "gpt-5.6-luna";
export const CHAT_MODEL_PAID_DEFAULT = "gpt-5.6-terra";
export const CHAT_MODELS_ALLOWED = [
  CHAT_MODEL_PAID_DEFAULT,
  CHAT_MODEL_FREE,
  "gpt-4o",
  "gpt-4o-mini",
];

// Low-frequency internal helper models.
export const MODEL_TRANSCRIPTION = "gpt-4o-mini-transcribe";
export const MODEL_SUMMARIZE = "gpt-4o-mini";
export const MODEL_RECIPE_TRANSLATION = "gpt-4o-mini";
export const MODEL_RECIPE_DEDUPE = "gpt-4o-mini";
export const MODEL_RECIPE_MISSING_ITEMS = "gpt-4o-mini";
export const MODEL_RECIPE_TEXT_EXTRACT = "gpt-4o-mini";

// Defaults for the env-overridable recipe models. Set the corresponding
// RECIPE_ESTIMATION_MODEL / RECIPE_IDEATION_MODEL env var to override at runtime.
export const MODEL_RECIPE_ESTIMATION_DEFAULT = "gpt-4o-mini";
export const MODEL_RECIPE_IDEATION_DEFAULT = "gpt-4o-mini";
