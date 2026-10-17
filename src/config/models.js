// Central AI model configuration.
// Change these values to switch the model the backend uses for each role.
//
// Note: explicit prompt-cache breakpoints, reasoning support, and Responses
// API routing are gated separately in policy.js. If you point a chat model at
// a model those allowlists do not cover, update them to match.

// Interactive chat (WebSocket) models.
//
// One model serves every tier. Verified against the live API on 2026-10-16:
// gpt-6-luna accepts function tools on both Chat Completions (with
// reasoning_effort "none") and the Responses API, plus the explicit
// prompt-cache breakpoint marker. Tiers are separated by quota and features,
// not by model quality.
export const CHAT_MODEL_FREE = "gpt-6-luna";
export const CHAT_MODEL_PAID_DEFAULT = "gpt-6-luna";

// Server-side capability list. The legacy entries stay so an existing
// APPLE_SUBSCRIPTION_PLANS_JSON override that still names them keeps
// validating at startup; nothing defaults to them.
export const CHAT_MODELS_ALLOWED = [
  CHAT_MODEL_PAID_DEFAULT,
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-4o",
  "gpt-4o-mini",
];

// Low-frequency internal helper models. These run on the same model as chat,
// so prompt and output behaviour stays consistent across surfaces.
//
// GPT-6 rejects `temperature`, `top_p`, and `max_tokens`. Helper call sites
// must send `max_completion_tokens` and omit sampling parameters.
export const MODEL_SUMMARIZE = CHAT_MODEL_FREE;
export const MODEL_RECIPE_TRANSLATION = CHAT_MODEL_FREE;
export const MODEL_RECIPE_DEDUPE = CHAT_MODEL_FREE;
export const MODEL_RECIPE_MISSING_ITEMS = CHAT_MODEL_FREE;
export const MODEL_RECIPE_TEXT_EXTRACT = CHAT_MODEL_FREE;

// Defaults for the env-overridable recipe models. Set the corresponding
// RECIPE_ESTIMATION_MODEL / RECIPE_IDEATION_MODEL env var to override at runtime.
export const MODEL_RECIPE_ESTIMATION_DEFAULT = CHAT_MODEL_FREE;
export const MODEL_RECIPE_IDEATION_DEFAULT = CHAT_MODEL_FREE;
