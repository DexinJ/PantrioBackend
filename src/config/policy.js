// src/config/policy.js
import { parseNodeEnvironment } from "./runtimeConfig.js";

// Full access models (signed-in users)
// Non-subscribers are narrowed to NON_SUBSCRIBER_CHAT_MODEL below.
export const ALLOWED_MODELS_AUTHED = new Set([
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  
  // Trial models (cheap + predictable)
  export const ALLOWED_MODELS_TRIAL = new Set([
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ]);

  // All users without an active subscription are forced onto this model.
  // Keep ALLOWED_MODELS_TRIAL above unchanged for protocol/history reference.
  export const NON_SUBSCRIBER_CHAT_MODEL = "gpt-5-mini";
  export const ALLOWED_MODELS_NON_SUBSCRIBER = new Set([
    NON_SUBSCRIBER_CHAT_MODEL,
  ]);
  
  // Tools allowed during trial
  export const TRIAL_ALLOWED_TOOLS = new Set([
    "webSearch",
    "webFetch",
    "addFridgeItem",
    "addShoppingItem",
    "removeFridgeItem",
    "removeShoppingItem",
    "findInFridge",
    "findInShoppingList",
    "getFridgeContents",
    "getShoppingListContents",
    "proposeAddAllToFridge",
    "streamlineLists", // ✅ NEW (replaces listItemsAndUpdateTags)
  ]);
  
  // Trial token budgets (SQLite-backed daily quota)
  export const TRIAL_TOKENS_PER_DAY = 20_000;      // adjust to your product
  export const TRIAL_MAX_COMPLETION_TOKENS = 600;  // per request cap

  // The existing trial budget is now the shared daily budget for every
  // user whose stored subscription is not entitled. Keep the trial names
  // above for protocol/backward compatibility.
  export const NON_SUBSCRIBER_TOKENS_PER_DAY = TRIAL_TOKENS_PER_DAY;
  export const NON_SUBSCRIBER_MAX_COMPLETION_TOKENS =
    TRIAL_MAX_COMPLETION_TOKENS;
  export const SUBSCRIBER_MAX_COMPLETION_TOKENS = 4_000;
  export const SUBSCRIBER_MAX_PROMPT_TOKENS = 50_000;
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
