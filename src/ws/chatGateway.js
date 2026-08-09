// src/ws/chatGateway.js
import {
  // ALLOWED_MODELS_AUTHED,
  // ALLOWED_MODELS_TRIAL,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_PAYLOAD_DEPTH,
  MAX_CHAT_PAYLOAD_NODES,
  MAX_TOOL_ROUNDS,
  START_LIMIT_AUTHED,
  // TRIAL_TOKENS_PER_DAY, // Superseded by the shared non-subscriber quota.
} from "../config/policy.js";

import { rateLimitStart } from "../utils/rateLimit.js";
import { newId } from "../utils/ids.js";
import { safeJsonParse } from "../utils/json.js";

import { verifyFirebaseToken } from "../auth/firebase.js";
import { getDb } from "../db/db.js";
// import { parseOwner, getUsageRow, addUsage } from "../usage/usageStore.js";
import {
  getUsageRow,
  parseOwner,
  reconcileUsageReservation,
  reserveUsage,
} from "../usage/usageStore.js";
// import { computeTrialMaxTokens, remainingTrialTokens } from "../usage/trialBudget.js";
// The trial-only helper above is retained as a comment for migration history.
import {
  computeTokenBudget,
  estimateTokensFromMessages,
} from "../usage/tokenBudget.js";
import { getUserSubscription } from "../subscriptions/subscriptionStore.js";
import { resolveSubscriptionAccess } from "../subscriptions/entitlementPolicy.js";
import {
  createQuotaSnapshot,
  getQuotaSnapshot,
  quotaLegacyFields,
} from "../usage/quotaSnapshot.js";

import { streamOpenAIOnce } from "../chat/openaiStream.js";
import { resolveChatModel } from "../chat/modelPolicy.js";
import { OPENAI_TOOLS } from "../chat/tools.js";
import { runToolCalls } from "../chat/toolRunner.js"; // ✅ HYBRID: enable server-side tools

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function quotaFromRemaining(remainingTokens, dailyLimit) {
  return createQuotaSnapshot({
    applies: true,
    tokensUsed: Math.max(
      0,
      dailyLimit - remainingTokens
    ),
    dailyLimit,
  });
}

function sendQuotaError(
  ws,
  { requestId, code, message, quota = null, retryAfterMs }
) {
  send(ws, {
    type: "error",
    requestId,
    code,
    message,
    ...(quota ? { quota, ...quotaLegacyFields(quota) } : {}),
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  });
}

const CLIENT_MESSAGE_ROLES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
]);

function validatePayloadComplexity(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (
      nodes > MAX_CHAT_PAYLOAD_NODES ||
      current.depth > MAX_CHAT_PAYLOAD_DEPTH
    ) {
      return false;
    }

    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }

  return true;
}

function validateStartMessages(messages) {
  if (!Array.isArray(messages)) return "messages must be an array";
  if (messages.length === 0) return "messages must not be empty";
  if (messages.length > MAX_CHAT_MESSAGES) {
    return `messages must contain at most ${MAX_CHAT_MESSAGES} items`;
  }
  if (
    messages.some(
      (message) =>
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        !CLIENT_MESSAGE_ROLES.has(message.role) ||
        !(typeof message.content === "string" || Array.isArray(message.content))
    )
  ) {
    return "each message must contain a valid role and content";
  }
  if (!validatePayloadComplexity(messages)) {
    return "messages are too deeply nested or complex";
  }
  return null;
}

function validateToolResults(results) {
  if (!Array.isArray(results)) return false;
  if (results.length > MAX_CHAT_MESSAGES) return false;
  if (
    results.some(
      (result) =>
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        typeof (result.tool_call_id || result.id) !== "string"
    )
  ) {
    return false;
  }
  return validatePayloadComplexity(results);
}

/**
 * Convert client tool_results payload into Chat Completions tool messages.
 * Expected from client:
 *  { type:"tool_results", requestId, results: [{ tool_call_id, name, content }] }
 */
function toolResultsToToolMessages(results) {
  const arr = Array.isArray(results) ? results : [];
  return arr
    .map((r) => {
      const tool_call_id = r?.tool_call_id || r?.id || null;
      const content =
        typeof r?.content === "string"
          ? r.content
          : JSON.stringify(r?.content ?? {});
      if (!tool_call_id) return null;
      return { role: "tool", tool_call_id, content };
    })
    .filter(Boolean);
}

/**
 * For Chat Completions, when the assistant requests tools, you must append:
 *  - an assistant message with tool_calls
 *  - one tool message per tool_call_id with the tool output
 */
function makeAssistantToolCallMsg(toolCalls) {
  return {
    role: "assistant",
    tool_calls: Array.isArray(toolCalls) ? toolCalls : [],
    content: null,
  };
}

// ✅ HYBRID: server-only tools (secrets / internet)
const SERVER_TOOLS = new Set([
  "webSearch",
  // "webFetch", // add if you implement page fetching
]);

function splitToolCalls(toolCalls) {
  const serverCalls = [];
  const clientCalls = [];
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = tc?.function?.name;
    if (name && SERVER_TOOLS.has(name)) serverCalls.push(tc);
    else clientCalls.push(tc);
  }
  return { serverCalls, clientCalls };
}

function withTimeout(promise, ms, msg = "Timed out") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function attachChatGateway(wss) {
  wss.on("connection", (ws) => {
    const active = new Map();
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    send(ws, { type: "hello", serverTime: Date.now() });

    // ✅ HYBRID: resume when we have ALL tool_call_id results (server + client)
    function maybeResumeAfterTools(requestId) {
      const state = active.get(requestId);
      if (!state) return;

      const allIds = (state.toolCalls || []).map((tc) => tc?.id).filter(Boolean);
      const haveIds = new Set((state.collectedToolMsgs || []).map((m) => m.tool_call_id));

      const missing = allIds.filter((id) => !haveIds.has(id));
      if (missing.length) return; // still waiting

      // stop timeout
      if (state.toolResultsTimeout) {
        clearTimeout(state.toolResultsTimeout);
        state.toolResultsTimeout = null;
      }

      // Append assistant tool_calls + all tool outputs
      const assistantToolCallMsg = makeAssistantToolCallMsg(state.toolCalls);
      state.workingMessages = [
        ...state.workingMessages,
        assistantToolCallMsg,
        ...(state.collectedToolMsgs || []),
      ];

      // clear tool state
      state.awaitingTools = false;
      state.toolCalls = [];
      state.collectedToolMsgs = [];
      state.pendingToolResults = null;

      runOneRound(requestId).catch((e) => {
        send(ws, {
          type: "error",
          requestId,
          message: e?.message || "Failed to continue after tools.",
        });
        active.delete(requestId);
      });
    }

    async function runOneRound(requestId) {
      const state = active.get(requestId);
      if (!state) return;

      const {
        controller,
        model,
        workingMessages,
        // maxTokensForThisRequest, // Replaced by a fresh per-round quota check.
        db,
        ownerType,
        ownerKey,
        isAuthed,
        quotaApplies,
        plan,
        dailyLimit,
      } = state;

      let maxTokensForThisRound = plan.maxCompletionTokens;
      let quotaReservation = null;
      const budgetMessages = [
        ...workingMessages,
        { role: "system", content: { tools: OPENAI_TOOLS } },
      ];

      if (estimateTokensFromMessages(budgetMessages) > plan.maxPromptTokens) {
        send(ws, {
          type: "error",
          requestId,
          code: "REQUEST_TOO_LARGE",
          message: "This conversation is too large to send.",
        });
        active.delete(requestId);
        return;
      }

      if (quotaApplies) {
        const usage = await getUsageRow(db, ownerType, ownerKey);
        const budget = computeTokenBudget({
          tokensUsed: usage.tokens_used,
          dailyLimit,
          maxCompletionTokens: plan.maxCompletionTokens,
          messages: budgetMessages,
        });

        if (!budget.ok) {
          const quota = quotaFromRemaining(budget.remainingTokens, dailyLimit);
          sendQuotaError(ws, {
            requestId,
            code:
              budget.remainingTokens <= 0
                ? "QUOTA_EXHAUSTED"
                : "REQUEST_TOO_LARGE",
            message: budget.reason,
            quota,
          });
          active.delete(requestId);
          return;
        }

        maxTokensForThisRound = budget.maxCompletionTokens;
        const reserveTokens =
          budget.estPromptTokens + budget.maxCompletionTokens;
        quotaReservation = await reserveUsage(
          db,
          ownerType,
          ownerKey,
          reserveTokens,
          dailyLimit
        );

        if (!quotaReservation) {
          const latestUsage = await getUsageRow(db, ownerType, ownerKey);
          const quota = createQuotaSnapshot({
            applies: true,
            tokensUsed: latestUsage.tokens_used,
            dailyLimit,
          });
          sendQuotaError(ws, {
            requestId,
            code: "QUOTA_EXHAUSTED",
            message:
              "Not enough daily token budget remains for this request.",
            quota,
          });
          active.delete(requestId);
          return;
        }

        const quota = await getQuotaSnapshot(
          db,
          ownerType,
          ownerKey,
          true,
          { dailyLimit }
        );
        send(ws, {
          type: isAuthed ? "quota_budget" : "trial_budget",
          requestId,
          quota,
          ...quotaLegacyFields(quota),
          estPromptTokens: budget.estPromptTokens,
          maxCompletionTokens: maxTokensForThisRound,
        });
      }

      /* Previous direct stream call. Quota-limited calls now reserve their
         estimated upper bound first and reconcile after provider usage arrives.
      const one = await streamOpenAIOnce({
        ws,
        send,
        requestId,
        model,
        messages: workingMessages,
        controller,
        maxTokens: maxTokensForThisRound,
      });
      */
      let one;

      try {
        one = await streamOpenAIOnce({
          ws,
          send,
          requestId,
          model,
          messages: workingMessages,
          controller,
          // maxTokens: maxTokensForThisRequest,
          maxTokens: maxTokensForThisRound,
        });
      } catch (error) {
        if (quotaReservation) {
          await reconcileUsageReservation(
            db,
            ownerType,
            ownerKey,
            quotaReservation,
            null,
            1
          );
        }
        throw error;
      }

      if (!one.ok) {
        let quota = null;
        if (quotaReservation) {
          await reconcileUsageReservation(
            db,
            ownerType,
            ownerKey,
            quotaReservation,
            0,
            0
          );
          quota = await getQuotaSnapshot(
            db,
            ownerType,
            ownerKey,
            true,
            { dailyLimit }
          );
        }
        sendQuotaError(ws, {
          requestId,
          code: one?.error?.code || "UPSTREAM_ERROR",
          message:
            one?.error?.message || "The AI service could not complete the request.",
          quota,
        });
        active.delete(requestId);
        return;
      }

      /* Previous post-hoc guest accounting. This allowed concurrent requests
         and interrupted streams to consume tokens before anything was charged.
      // Usage accounting (trial)
      // Usage accounting (all users without a stored active subscription)
      // if (!isAuthed) {
      if (quotaApplies) {
        await addUsage(db, ownerType, ownerKey, 0, 1);

        if (one?.usage?.total_tokens) {
          await addUsage(db, ownerType, ownerKey, one.usage.total_tokens, 0);

          const u2 = await getUsageRow(db, ownerType, ownerKey);
          // const remainingNow = Math.max(0, TRIAL_TOKENS_PER_DAY - u2.tokens_used);
          const remainingNow = computeRemainingTokens(
            u2.tokens_used,
            NON_SUBSCRIBER_TOKENS_PER_DAY
          );

          send(ws, {
            // type: "trial_budget_update",
            type: isAuthed ? "quota_budget_update" : "trial_budget_update",
            requestId,
            usedTokens: u2.tokens_used,
            remainingTokens: remainingNow,
            dailyLimit: NON_SUBSCRIBER_TOKENS_PER_DAY,
          });
        }
      }
      */

      if (quotaReservation) {
        const actualTokens = Number.isFinite(one?.usage?.total_tokens)
          ? Math.max(0, Math.trunc(one.usage.total_tokens))
          : null;
        await reconcileUsageReservation(
          db,
          ownerType,
          ownerKey,
          quotaReservation,
          actualTokens,
          1
        );

        const quota = await getQuotaSnapshot(
          db,
          ownerType,
          ownerKey,
          true,
          { dailyLimit }
        );

        send(ws, {
          // type: "trial_budget_update",
          type: isAuthed ? "quota_budget_update" : "trial_budget_update",
          requestId,
          quota,
          ...quotaLegacyFields(quota),
          usageEstimated: actualTokens === null,
        });
      }

      // Normal completion
      if (!one.needsTools) {
        send(ws, { type: "done", requestId });
        active.delete(requestId);
        return;
      }

      if ((state.round || 0) >= MAX_TOOL_ROUNDS) {
        send(ws, {
          type: "error",
          requestId,
          code: "TOOL_ROUND_LIMIT",
          message: "The request used too many consecutive tool rounds.",
        });
        active.delete(requestId);
        return;
      }

      // Tool calls required
      state.awaitingTools = true;
      state.toolCalls = one.toolCalls || [];
      state.collectedToolMsgs = [];
      state.round = (state.round || 0) + 1;

      const { serverCalls, clientCalls } = splitToolCalls(state.toolCalls);

      // ✅ HYBRID: run server tools immediately (e.g., webSearch)
      if (serverCalls.length) {
        const ctx = {
          requestId,
          isAuthed: state.isAuthed,
          wsSend: (obj) => send(ws, obj),
          userId: state.userId,
          db: state.db,
          ownerType: state.ownerType,
          ownerKey: state.ownerKey,
        };

        try {
          // keep a timeout so Serper fetch doesn't hang
          const serverToolMsgs = await withTimeout(
            runToolCalls(serverCalls, ctx),
            25_000,
            "Server tool execution timed out."
          );
          state.collectedToolMsgs.push(...(Array.isArray(serverToolMsgs) ? serverToolMsgs : []));
        } catch (e) {
          send(ws, {
            type: "error",
            requestId,
            message: e?.message || "Server tool execution failed.",
          });
          active.delete(requestId);
          return;
        }
      }

      // ✅ HYBRID: if there are client tools, request tool_results for ONLY those
      if (clientCalls.length) {
        send(ws, {
          type: "awaiting_tool_results",
          requestId,
          round: state.round,
          toolCalls: clientCalls, // IMPORTANT: client executes ONLY these
        });

        // If tool_results arrived early, consume immediately
        if (state.pendingToolResults) {
          const toolMsgs = toolResultsToToolMessages(state.pendingToolResults);
          state.collectedToolMsgs.push(...toolMsgs);
          state.pendingToolResults = null;
          maybeResumeAfterTools(requestId);
          return;
        }

        // Timeout waiting for client
        if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
        state.toolResultsTimeout = setTimeout(() => {
          const s2 = active.get(requestId);
          if (!s2) return;
          if (s2.awaitingTools) {
            send(ws, {
              type: "error",
              requestId,
              message: "Timed out waiting for tool results from client.",
            });
            active.delete(requestId);
          }
        }, 30_000);

        return; // wait for client tool_results
      }

      // ✅ HYBRID: server-only tool calls -> resume immediately
      maybeResumeAfterTools(requestId);
    }

    ws.on("message", async (raw) => {
      const parsed = safeJsonParse(raw.toString());
      if (!parsed.ok) return send(ws, { type: "error", message: "Invalid JSON" });

      const msg = parsed.value;

      // Cancel
      if (msg.type === "cancel") {
        const requestId = msg.requestId;
        const state = active.get(requestId);
        if (state?.controller) state.controller.abort();
        if (state?.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
        active.delete(requestId);
        send(ws, { type: "done", requestId, cancelled: true });
        return;
      }

      // Tool results from client (RESUME)
      if (msg.type === "tool_results") {
        const requestId = msg.requestId;
        const state = active.get(requestId);

        if (!state) {
          return send(ws, {
            type: "error",
            requestId,
            message: "No active request for tool_results.",
          });
        }

        if (!validateToolResults(msg.results)) {
          state.controller?.abort?.();
          if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
          active.delete(requestId);
          return send(ws, {
            type: "error",
            requestId,
            code: "INVALID_REQUEST",
            message: "tool_results is invalid or too complex.",
          });
        }

        // EARLY tool_results race: buffer it
        if (!state.awaitingTools) {
          state.pendingToolResults = msg.results || [];
          send(ws, {
            type: "queued_tool_results",
            requestId,
            message: "Received tool_results early; queued until server is ready.",
          });
          return;
        }

        // stop timeout
        if (state.toolResultsTimeout) {
          clearTimeout(state.toolResultsTimeout);
          state.toolResultsTimeout = null;
        }

        const toolMsgs = toolResultsToToolMessages(msg.results || []);
        state.collectedToolMsgs = state.collectedToolMsgs || [];
        state.collectedToolMsgs.push(...toolMsgs);

        // Resume ONLY when we have all tool_call_id outputs (server + client)
        maybeResumeAfterTools(requestId);
        return;
      }

      // Start
      if (msg.type !== "start") {
        return send(ws, { type: "error", message: "Unknown message type" });
      }

      if (
        msg.requestId !== undefined &&
        (typeof msg.requestId !== "string" ||
          msg.requestId.length === 0 ||
          msg.requestId.length > 128)
      ) {
        send(ws, {
          type: "error",
          code: "INVALID_REQUEST",
          message: "requestId must be a non-empty string of at most 128 characters.",
        });
        return;
      }
      const requestId = msg.requestId || newId();

      if (!msg.token) {
        send(ws, {
          type: "error",
          requestId,
          code: "AUTH_REQUIRED",
          message: "Sign in is required to use chat.",
        });
        return;
      }

      let userId;
      try {
        const decoded = await verifyFirebaseToken(msg.token);
        userId = decoded.uid;
      } catch {
        send(ws, {
          type: "error",
          requestId,
          code: "AUTH_INVALID",
          message: "Invalid token",
        });
        return;
      }

      const messageValidationError = validateStartMessages(msg.messages);
      if (messageValidationError) {
        send(ws, {
          type: "error",
          requestId,
          code: "INVALID_REQUEST",
          message: messageValidationError,
        });
        return;
      }

      const isAuthed = true;
      const messages = msg.messages;

      const db = await getDb();
      const { ownerType, ownerKey } = parseOwner(userId, true);
      const subscription = await getUserSubscription(db, userId);
      const { active: isSubscribed, plan } = resolveSubscriptionAccess(
        subscription
      );
      const dailyLimit = plan.dailyTokenLimit;
      const quotaApplies = dailyLimit !== null;

      const rl = rateLimitStart(`user:${userId}`, START_LIMIT_AUTHED);
      if (!rl.ok) {
        const quota = await getQuotaSnapshot(
          db,
          ownerType,
          ownerKey,
          quotaApplies,
          { dailyLimit: dailyLimit ?? undefined }
        );
        sendQuotaError(ws, {
          requestId,
          code: "RATE_LIMITED",
          message: `Rate limited. Try again in ${Math.ceil(
            rl.retryAfterMs / 1000
          )}s`,
          quota,
          retryAfterMs: rl.retryAfterMs,
        });
        return;
      }

      /* Previous authentication-based model policy. Subscription status now
         controls model access, and non-subscribers are forced to GPT-5 mini.
      // Model policy per mode
      const model = msg.model || (isAuthed ? "gpt-5" : "gpt-4o-mini");
      const allowedModels = isAuthed ? ALLOWED_MODELS_AUTHED : ALLOWED_MODELS_TRIAL;

      if (!allowedModels.has(model)) {
        send(ws, {
          type: "error",
          requestId,
          message: isAuthed ? "Model not allowed" : "Trial: model not available. Please sign in.",
        });
        return;
      }
      */

      const modelResolution = resolveChatModel({
        requestedModel: msg.model,
        isSubscribed,
        plan,
      });

      if (!modelResolution.ok) {
        send(ws, {
          type: "error",
          requestId,
          code: "MODEL_NOT_ALLOWED",
          message: modelResolution.reason,
        });
        return;
      }

      const model = modelResolution.model;

      if (
        msg.language !== undefined &&
        (typeof msg.language !== "string" || msg.language.length > 32)
      ) {
        send(ws, {
          type: "error",
          requestId,
          code: "INVALID_REQUEST",
          message: "language must be a string of at most 32 characters.",
        });
        return;
      }
      const language = msg.language?.trim() || "en";

      // SQLite-backed token budget enforcement (trial)
      // const db = await getDb();
      // const { ownerType, ownerKey } = parseOwner(userId, isAuthed);

      // const subscription = isAuthed
      //   ? await getUserSubscription(db, userId)
      //   : null;
      // const isSubscribed = subscription?.isSubscribed === true;
      // const quotaApplies = !isSubscribed;

      /* Previous guest-only preflight. The per-round check in runOneRound now
         covers guests and authenticated non-subscribers, including tool rounds.
      let maxTokensForThisRequest = undefined;

      if (!isAuthed) {
        const usage = await getUsageRow(db, ownerType, ownerKey);
        const remaining = remainingTrialTokens(usage.tokens_used);

        if (remaining <= 0) {
          send(ws, {
            type: "error",
            requestId,
            message: "Trial limit reached. Please sign in to continue.",
          });
          return;
        }

        const budget = computeTrialMaxTokens({ remainingTokens: remaining, messages });
        if (!budget.ok) {
          send(ws, { type: "error", requestId, message: budget.reason });
          return;
        }

        maxTokensForThisRequest = budget.maxCompletionTokens;

        send(ws, {
          type: "trial_budget",
          requestId,
          remainingTokens: remaining,
          dailyLimit: TRIAL_TOKENS_PER_DAY,
          estPromptTokens: budget.estPromptTokens,
          maxCompletionTokens: maxTokensForThisRequest,
        });
      }
      */

      const controller = new AbortController();

      // Store full state for hybrid tool execution
      active.set(requestId, {
        controller,
        workingMessages: [
          { role: "system", content: `Reply in ${language}.` },
          ...messages,
        ],
        model,
        language,
        isAuthed,
        userId,
        db,
        ownerType,
        ownerKey,
        // maxTokensForThisRequest,
        isSubscribed,
        quotaApplies,
        plan,
        dailyLimit,
        round: 0,

        awaitingTools: false,
        toolCalls: [],
        collectedToolMsgs: [],
        toolResultsTimeout: null,
        pendingToolResults: null,
      });

      // send(ws, { type: "started", requestId, isAuthed });
      send(ws, {
        type: "started",
        requestId,
        isAuthed,
        isSubscribed,
        quotaApplies,
        model,
        requestedModel: modelResolution.requestedModel,
        modelRestricted: plan.id === "free",
        requestWasRestricted: modelResolution.wasRestricted,
      });

      runOneRound(requestId).catch((err) => {
        const isAbort = err && err.name === "AbortError";
        send(
          ws,
          isAbort
            ? { type: "done", requestId, cancelled: true }
            : {
                type: "error",
                requestId,
                code: "UPSTREAM_ERROR",
                message: err?.message || "Stream error",
              }
        );
        const st = active.get(requestId);
        if (st?.toolResultsTimeout) clearTimeout(st.toolResultsTimeout);
        active.delete(requestId);
      });
    });

    ws.on("close", () => {
      for (const state of active.values()) {
        state.controller?.abort?.();
        if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
      }
      active.clear();
    });
  });

  // Heartbeat loop
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(interval));
}
