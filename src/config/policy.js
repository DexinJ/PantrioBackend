// src/config/policy.js
import { parseNodeEnvironment } from "./runtimeConfig.js";
import { CHAT_MODEL_FREE, CHAT_MODELS_ALLOWED } from "./models.js";
import {
  MASS_ADD_SHOPPING_ITEMS_TOOL_NAME,
  RECOMMEND_RECIPES_TOOL_NAME,
} from "../chat/toolNames.js";

// Full access models (signed-in users)
// Non-subscribers are narrowed to NON_SUBSCRIBER_CHAT_MODEL below.
export const ALLOWED_MODELS_AUTHED = new Set(CHAT_MODELS_ALLOWED);
  
  // All users without an active subscription are forced onto this model.
  export const NON_SUBSCRIBER_CHAT_MODEL = CHAT_MODEL_FREE;
  export const ALLOWED_MODELS_NON_SUBSCRIBER = new Set([
    NON_SUBSCRIBER_CHAT_MODEL,
  ]);

  // Models that support explicit prompt-cache breakpoints (GPT-5.6 generation).
  // Earlier models (gpt-4o / gpt-4o-mini) are implicit-cache only and must not
  // receive the breakpoint marker or prompt_cache_options.
  export const EXPLICIT_CACHE_BREAKPOINT_MODELS = new Set([
    "gpt-5.6-luna",
    "gpt-5.6-terra",
  ]);

  // Models that accept a top-level `reasoning_effort` field in Chat Completions.
  //
  // Verified against the live API on 2026-09-27: on the GPT-5.6 generation,
  // Chat Completions rejects function tools unless `reasoning_effort` is
  // explicitly "none". Omitting the field fails too, because the model defaults
  // to "medium" — so the value must be sent, not left out. This applies to BOTH
  // gpt-5.6-terra and gpt-5.6-luna; there is no Luna-only exception.
  //
  // gpt-6-astra is deliberately excluded: it requires the Responses API for
  // tool calling and returns HTTP 400 for "none" effort. Earlier models
  // (gpt-4o / gpt-4o-mini) reject the field entirely.
  export const CHAT_REASONING_EFFORT_MODELS = new Set([
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);

  // Effort Chat Completions requires whenever function tools are attached.
  export const CHAT_TOOLS_REASONING_EFFORT = "none";

  // Default reasoning effort for models that support it when no tools are sent.
  export const DEFAULT_REASONING_EFFORT = "medium";

  // ---------------------------------------------------------------------------
  // Interactive chat endpoint selection
  // ---------------------------------------------------------------------------
  //
  // Chat Completions cannot run reasoning and function tools together on the
  // GPT-5.6 generation (verified against the live API on 2026-09-27 — it
  // returns 400 unless effort is forced to "none"). The Responses API has no
  // such restriction, so these models route there.
  export const RESPONSES_API_MODELS = new Set([
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);

  // Rollout switch. Set CHAT_RESPONSES_API=false to send these models back to
  // Chat Completions (with effort forced to "none") without a code change.
  export const RESPONSES_API_ENABLED = !/^(0|false|no)$/i.test(
    String(process.env.CHAT_RESPONSES_API || "").trim()
  );

  export function usesResponsesApi(model) {
    return (
      RESPONSES_API_ENABLED === true &&
      typeof model === "string" &&
      RESPONSES_API_MODELS.has(model)
    );
  }

  // ---------------------------------------------------------------------------
  // Reasoning policy — STRUCTURE ONLY
  // ---------------------------------------------------------------------------
  //
  // The free/paid effort split is still a product decision, so no tier values
  // are hardcoded here. Everything below is deployment configuration, overridden
  // per plan (or per model) with REASONING_POLICY_JSON, for example:
  //   { "default": { "effort": "low", "applyTo": "recommendRecipes" },
  //     "pro":     { "effort": "medium" } }
  //
  // `applyTo` decides which rounds may reason. Everything it does not select is
  // sent as an explicit effort of "none", which keeps the cost of a long tool
  // loop bounded:
  //   * "recommendRecipes" (default) - only the round that forces the
  //     recommendRecipes tool. Recipe mode pins its tool ladder, so round 0
  //     (getFridgeContents) takes no arguments and has nothing to reason about,
  //     while the recommendRecipes round has to build real arguments from the
  //     fridge inventory.
  //   * "first" - the original behaviour: reason on round 0 only.
  //   * "all" - every round.
  //
  // `context` maps to reasoning.context; the GPT-5.6 default is "all_turns",
  // which renders earlier reasoning into later turns and grows input tokens, so
  // "current_turn" is the cheaper starting point.
  //
  // Note: none of the RESPONSES_API_MODELS reject "none". gpt-6-astra does
  // (HTTP 400), so routing it here would require sending "minimal" on the
  // non-selected rounds instead.
  export const DEFAULT_REASONING_POLICY = Object.freeze({
    enabled: true,
    effort: "low",
    context: "current_turn",
    applyTo: "recommendRecipes",
  });

  const REASONING_EFFORT_VALUES = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  const REASONING_APPLY_TO_VALUES = new Set([
    "recommendRecipes",
    "first",
    "all",
  ]);

  // Safety limit only: extra output budget so reasoning tokens do not consume
  // the user-facing completion allowance. Quota is still governed by the plan's
  // maxCompletionTokens; this only caps the provider request.
  const configuredReasoningAllowance = Number.parseInt(
    String(process.env.RESPONSES_REASONING_OUTPUT_ALLOWANCE || "").trim(),
    10
  );
  export const RESPONSES_REASONING_OUTPUT_ALLOWANCE =
    Number.isFinite(configuredReasoningAllowance) &&
    configuredReasoningAllowance > 0
      ? configuredReasoningAllowance
      : 8_000;

  // Read once at boot, like the other policy constants, so the effective
  // configuration is reproducible for the life of the process.
  const REASONING_POLICY_OVERRIDE = (() => {
    try {
      const raw = String(process.env.REASONING_POLICY_JSON || "").trim();
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  })();

  function policySection(container, key) {
    const section = key ? container?.[key] : null;
    return section && typeof section === "object" && !Array.isArray(section)
      ? section
      : {};
  }

  function reasoningApplies({ applyTo, roundNumber, forcedTool }) {
    switch (applyTo) {
      case "all":
        return true;
      case "first":
        return roundNumber === 0;
      case "recommendRecipes":
      default:
        return forcedTool === RECOMMEND_RECIPES_TOOL_NAME;
    }
  }

  /**
   * Resolve the reasoning settings for one request round.
   * Returns `null` when reasoning should be omitted from the request.
   */
  export function resolveReasoningPolicy({
    plan = null,
    model = null,
    round = 0,
    forcedTool = null,
  } = {}) {
    const override = REASONING_POLICY_OVERRIDE;
    // Only the explicitly configured layers, so a legacy `rounds` key can be
    // told apart from the default `applyTo`.
    const overridePolicy = {
      ...policySection(override, "default"),
      ...policySection(override?.models, model),
      ...policySection(override, plan?.id),
    };
    const policy = { ...DEFAULT_REASONING_POLICY, ...overridePolicy };

    if (policy.enabled !== true) return null;

    const roundNumber = Number.isInteger(round) && round > 0 ? round : 0;
    // `rounds` was the original key name. Keep honouring it so an override
    // already deployed as REASONING_POLICY_JSON keeps its behaviour.
    const requestedApplyTo =
      overridePolicy.applyTo ??
      (overridePolicy.rounds === "first" ? "first" : undefined);
    const applyTo = REASONING_APPLY_TO_VALUES.has(requestedApplyTo)
      ? requestedApplyTo
      : DEFAULT_REASONING_POLICY.applyTo;

    if (
      !reasoningApplies({
        applyTo,
        roundNumber,
        forcedTool: typeof forcedTool === "string" ? forcedTool : null,
      })
    ) {
      return { effort: "none" };
    }

    return {
      effort: REASONING_EFFORT_VALUES.has(policy.effort)
        ? policy.effort
        : DEFAULT_REASONING_POLICY.effort,
      context:
        policy.context === "all_turns" ? "all_turns" : "current_turn",
    };
  }

  // Safety toggle for the backend's explicit cache boundary. Flip to false to
  // fall back to implicit caching without a redeploy.
  export const EXPLICIT_PROMPT_CACHE_ENABLED = true;

  // Keep every round's tool array identical so the request prefix stays
  // byte-identical and mid-turn rounds can reuse the cached prefix. The model's
  // `tools` list participates in the cached prefix, so shrinking it per round
  // (the previous behaviour) made every tool round a cache miss.
  //
  // With this on, which tools a round may *call* is narrowed by toolChoice and
  // an explicit allowlist instead of by removing them from the array. Flip to
  // false to restore the per-round arrays: a smaller prompt, but a cache miss
  // whenever the tool set changes.
  export const STABLE_TOOL_ARRAY_ENABLED = !/^(0|false|no)$/i.test(
    String(process.env.STABLE_TOOL_ARRAY || "").trim()
  );

  export function supportsExplicitCacheBreakpoints(model) {
    return (
      EXPLICIT_PROMPT_CACHE_ENABLED === true &&
      typeof model === "string" &&
      EXPLICIT_CACHE_BREAKPOINT_MODELS.has(model)
    );
  }
  
  // Tools allowed during trial
  export const TRIAL_ALLOWED_TOOLS = new Set([
    "webSearch",
    "recommendRecipes",
    "proposeRecipePreferenceUpdate",
    "addFridgeItem",
    "addShoppingItem",
    MASS_ADD_SHOPPING_ITEMS_TOOL_NAME,
    "removeFridgeItem",
    "removeShoppingItem",
    "findInFridge",
    "findInShoppingList",
    "getFridgeContents",
    "getShoppingListContents",
    "proposeAddAllToFridge",
    "streamlineLists", // ✅ NEW (replaces listItemsAndUpdateTags)
  ]);

  // Serper (web search) quota. Metering is implemented and always on; the
  // limit is deliberately unset and enforcement is off, so no request is ever
  // rejected for search volume yet. Flip these only after the recorded usage
  // from /api/session and the recipe_tool_meta logs has been reviewed.
  export const SERPER_QUOTA_ENFORCEMENT = false;
  export const SERPER_DAILY_LIMIT = null;

  // Client-side helper execution for BYO providers (custom API key / Apple AI).
  // On by default: the server returns helper task descriptors instead of
  // spending our OpenAI key on the user's behalf. Flip to false to fall back to
  // the old behaviour — every helper runs server-side again — without shipping
  // a new app build.
  export const BYO_CLIENT_HELPERS = true;

  // Recipe method policy.
  //
  // The engines never return the publisher's instruction steps. What they
  // return is `method` — a short summary the model writes in its own words,
  // checked against the source for verbatim reuse (recipeMethodGuard.js) — plus
  // `stepCount` and a link to the source page.
  //
  //   RECIPE_METHOD_SUMMARY=false  disables the summary entirely: cards then
  //                                show facts, the step count, and the link.
  //   RECIPE_METHOD_MODEL=...      overrides the summarizer model.
  //
  // The switch itself lives with the module that owns the prompt
  // (chat/recipeMethodSummary.js) so there is exactly one source of truth.
  
  // Trial token budgets (SQLite-backed daily quota)
  // TEMP: effectively unlimited for testing. Restore a product value (e.g.
  // 20_000) before shipping. See plan below for making this configurable.
  export const TRIAL_TOKENS_PER_DAY = 1_000_000_000;
  export const TRIAL_MAX_COMPLETION_TOKENS = 4_000;  // per request cap

  // The existing trial budget is now the shared daily budget for every
  // user whose stored subscription is not entitled. Keep the trial names
  // above for protocol/backward compatibility.
  export const NON_SUBSCRIBER_TOKENS_PER_DAY = TRIAL_TOKENS_PER_DAY;
  export const NON_SUBSCRIBER_MAX_COMPLETION_TOKENS =
    TRIAL_MAX_COMPLETION_TOKENS;
  export const SUBSCRIBER_MAX_COMPLETION_TOKENS = 4_000;
  export const SUBSCRIBER_MAX_PROMPT_TOKENS = 50_000;
  // When a free request is admitted as the last request of the day, cap its
  // completion allowance so the overshoot past the daily limit stays bounded.
  export const LAST_REQUEST_COMPLETION_TOKENS = 2_000;
  export const MAX_CHAT_MESSAGES = 50;
  export const MAX_CHAT_PAYLOAD_DEPTH = 20;
  export const MAX_CHAT_PAYLOAD_NODES = 10_000;
  export const MAX_TOOL_ROUNDS = 6;
  export const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

  // Client StoreKit snapshots are useful telemetry, but they are not proof of
  // purchase. Development environments may opt in temporarily while the Apple
  // server-verification flow is built. Production always fails closed.
  export const ALLOW_UNVERIFIED_SUBSCRIPTIONS =
    parseNodeEnvironment(process.env.NODE_ENV) !== "production" &&
    /^(1|true|yes)$/i.test(
      String(process.env.ALLOW_UNVERIFIED_SUBSCRIPTIONS || "")
    );

  // WS rate limits (per minute)
  export const START_LIMIT_AUTHED = { windowMs: 60_000, max: 12 };
  export const START_LIMIT_TRIAL = { windowMs: 60_000, max: 5 };
  export const MAX_CONCURRENT_CHAT_REQUESTS = 32;
  export const MAX_CONCURRENT_CHAT_REQUESTS_PER_USER = 2;
  // Bound work that is still authenticating or loading account state. These
  // slots are acquired before the first asynchronous preflight so unauthenticated
  // sockets cannot fan out unbounded Firebase/SQLite work.
  export const MAX_PENDING_CHAT_STARTS = 64;
  export const MAX_PENDING_CHAT_STARTS_PER_CONNECTION = 4;
