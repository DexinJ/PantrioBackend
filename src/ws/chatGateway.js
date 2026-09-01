// src/ws/chatGateway.js
import {
  // ALLOWED_MODELS_AUTHED,
  // ALLOWED_MODELS_TRIAL,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_PAYLOAD_DEPTH,
  MAX_CHAT_PAYLOAD_NODES,
  MAX_CONCURRENT_CHAT_REQUESTS,
  MAX_CONCURRENT_CHAT_REQUESTS_PER_USER,
  LAST_REQUEST_COMPLETION_TOKENS,
  MAX_PENDING_CHAT_STARTS,
  MAX_PENDING_CHAT_STARTS_PER_CONNECTION,
  MAX_TOOL_ROUNDS,
  START_LIMIT_AUTHED,
  // TRIAL_TOKENS_PER_DAY, // Superseded by the shared non-subscriber quota.
} from "../config/policy.js";

import { rateLimitStart } from "../utils/rateLimit.js";
import { newId } from "../utils/ids.js";
import { safeJsonParse } from "../utils/json.js";

import {
  verifyFirebaseToken,
  verifyFirebaseTokenSignature,
} from "../auth/firebase.js";
import { getDb } from "../db/db.js";
import {
  getAccountDeletion,
  publicAccountDeletion,
} from "../accountDeletion/accountDeletionStore.js";
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
  computeRemainingTokens,
  DAILY_TOKEN_LIMIT_REACHED_MESSAGE,
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
import {
  normalizeChatIntent,
  resolveRoundToolPolicy,
  sanitizeRecipeContext,
} from "../chat/recipeRequest.js";
import { PROPOSE_ADD_MISSING_INGREDIENTS_TO_SHOPPING_LIST_TOOL } from "../chat/tools.js";
import { runToolCalls } from "../chat/toolRunner.js"; // ✅ HYBRID: enable server-side tools
import { trimWorkingMessagesToFit } from "../chat/messageTrimmer.js";

let activeChatRequests = 0;
const activeChatRequestsByUser = new Map();
let pendingChatStarts = 0;

function acquireChatRequestSlot(uid) {
  const activeForUser = activeChatRequestsByUser.get(uid) || 0;
  if (
    activeChatRequests >= MAX_CONCURRENT_CHAT_REQUESTS ||
    activeForUser >= MAX_CONCURRENT_CHAT_REQUESTS_PER_USER
  ) {
    return null;
  }

  activeChatRequests += 1;
  activeChatRequestsByUser.set(uid, activeForUser + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeChatRequests = Math.max(0, activeChatRequests - 1);
    const remainingForUser = (activeChatRequestsByUser.get(uid) || 1) - 1;
    if (remainingForUser > 0) {
      activeChatRequestsByUser.set(uid, remainingForUser);
    } else {
      activeChatRequestsByUser.delete(uid);
    }
  };
}

function acquirePendingChatStartSlot(pendingForConnection) {
  if (
    pendingChatStarts >= MAX_PENDING_CHAT_STARTS ||
    pendingForConnection >= MAX_PENDING_CHAT_STARTS_PER_CONNECTION
  ) {
    return null;
  }

  pendingChatStarts += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    pendingChatStarts = Math.max(0, pendingChatStarts - 1);
  };
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (error) {
    console.error("[WebSocket send]", {
      name: String(error?.name || "Error"),
      code: error?.code ? String(error.code) : null,
    });
    return false;
  }
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
  "recommendRecipes",
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

async function withAbortDeadline({
  parentSignal,
  timeoutMs,
  message,
  operation,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    forwardAbort();
  } else {
    parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(message));
  }, timeoutMs);
  timeout.unref?.();

  try {
    const result = await operation(controller.signal);
    if (timedOut) {
      const error = new Error(message);
      error.name = "TimeoutError";
      error.code = "SERVER_TOOL_TIMEOUT";
      throw error;
    }
    return result;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(message, { cause: error });
      timeoutError.name = "TimeoutError";
      timeoutError.code = "SERVER_TOOL_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}

export function attachChatGateway(
  wss,
  {
    verifySignedTokenFn = verifyFirebaseTokenSignature,
    verifyActiveTokenFn = verifyFirebaseToken,
    getDbFn = getDb,
    streamOpenAIOnceFn = streamOpenAIOnce,
    runToolCallsFn = runToolCalls,
    serverToolTimeoutMs = 25_000,
    toolResultsTimeoutMs = 30_000,
  } = {}
) {
  let draining = false;
  const inFlightOperations = new Set();

  function trackOperation(operation) {
    const tracked = Promise.resolve(operation);
    inFlightOperations.add(tracked);
    tracked.then(
      () => inFlightOperations.delete(tracked),
      () => inFlightOperations.delete(tracked)
    );
    return tracked;
  }

  async function waitForIdle() {
    while (inFlightOperations.size > 0) {
      await Promise.allSettled([...inFlightOperations]);
    }
  }

  wss.on("connection", (ws) => {
    if (draining) {
      ws.close?.(1012, "Server restarting");
      return;
    }

    const active = new Map();
    const starting = new Map();
    let pendingStartsForConnection = 0;
    let connectionClosed = false;

    function deleteActiveRequest(requestId, { abort = false } = {}) {
      const state = active.get(requestId);
      if (!state) return false;
      if (abort) state.controller?.abort?.();
      if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
      state.releaseConcurrency?.();
      active.delete(requestId);
      return true;
    }

    async function handleRoundFailure(requestId, error) {
      const state = active.get(requestId);
      if (!state) return;

      try {
        const deletion = await getAccountDeletion(state.db, state.userId);
        if (deletion) {
          send(ws, {
            type: "error",
            requestId,
            code:
              deletion.status === "complete"
                ? "ACCOUNT_DELETED"
                : "ACCOUNT_DELETION_IN_PROGRESS",
            message:
              deletion.status === "complete"
                ? "This account has been deleted."
                : "Account deletion is in progress.",
            ...publicAccountDeletion(deletion),
          });
          deleteActiveRequest(requestId);
          return;
        }
      } catch (lookupError) {
        console.error("[WebSocket deletion-race lookup]", {
          name: String(lookupError?.name || "Error"),
          code: lookupError?.code ? String(lookupError.code) : null,
        });
      }

      console.error("[WebSocket chat round]", {
        name: String(error?.name || "Error"),
        code: error?.code ? String(error.code) : null,
      });
      if (error?.name === "AbortError") {
        send(ws, { type: "done", requestId, cancelled: true });
      } else if (error?.code === "UPSTREAM_TIMEOUT") {
        send(ws, {
          type: "error",
          requestId,
          code: "UPSTREAM_TIMEOUT",
          message: "The AI service timed out.",
        });
      } else {
        send(ws, {
          type: "error",
          requestId,
          code: "UPSTREAM_ERROR",
          message: "The AI service could not complete the request.",
        });
      }
      deleteActiveRequest(requestId);
    }

    function launchRound(requestId) {
      trackOperation(
        runOneRound(requestId).catch((error) =>
          handleRoundFailure(requestId, error)
        )
      );
    }
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    send(ws, { type: "hello", serverTime: Date.now() });

    // ✅ HYBRID: resume when we have ALL tool_call_id results (server + client)
    function acceptClientToolResults(requestId, state, results) {
      const allowedIds = state.clientToolCallIds;
      if (!(allowedIds instanceof Set)) return false;
      const receivedIds = state.receivedClientToolCallIds || new Set();
      state.receivedClientToolCallIds = receivedIds;
      const accepted = [];

      for (const result of results || []) {
        const id = result?.tool_call_id || result?.id;
        if (!allowedIds.has(id)) {
          send(ws, {
            type: "error",
            requestId,
            code: "INVALID_TOOL_RESULT",
            message: "tool_results contains an ID not assigned to this client.",
          });
          deleteActiveRequest(requestId, { abort: true });
          return false;
        }
        if (receivedIds.has(id)) continue;
        receivedIds.add(id);
        accepted.push(result);
      }

      state.collectedToolMsgs = state.collectedToolMsgs || [];
      state.collectedToolMsgs.push(...toolResultsToToolMessages(accepted));
      maybeResumeAfterTools(requestId);
      return true;
    }

    // Resume only after server-owned results exist and the client has returned
    // every ID the gateway explicitly assigned to it.
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
      state.acceptingClientToolResults = false;
      state.toolCalls = [];
      state.collectedToolMsgs = [];
      state.clientToolCallIds = new Set();
      state.pendingToolResults = null;

      launchRound(requestId);
    }

    async function runOneRound(requestId) {
      const state = active.get(requestId);
      if (!state) return;

      const {
        controller,
        model,
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
      const toolPolicy = state.toolsLockedAfterIsolatedAction
        ? state.recipeFollowUpAvailable && !state.recipeFollowUpUsed
          ? {
              tools: [PROPOSE_ADD_MISSING_INGREDIENTS_TO_SHOPPING_LIST_TOOL].filter(
                Boolean
              ),
              toolChoice: "auto",
              parallelToolCalls: false,
            }
          : {
              tools: [],
              toolChoice: undefined,
              parallelToolCalls: undefined,
            }
        : resolveRoundToolPolicy({
            intent: state.intent,
            round: state.round || 0,
          });
      const toolDefinitionMessages = toolPolicy.tools.length
        ? [{ role: "system", content: { tools: toolPolicy.tools } }]
        : [];
      const budgetMessages = [
        ...state.workingMessages,
        ...toolDefinitionMessages,
      ];
      let estPromptTokens = estimateTokensFromMessages(budgetMessages);

      // Per-request hard ceiling: prefer dropping the oldest tool rounds so a
      // user's request is never abandoned just because earlier rounds grew the
      // prompt. Only when even the base conversation is too large do we give up.
      if (estPromptTokens > plan.maxPromptTokens) {
        const trimmed = trimWorkingMessagesToFit(
          state.workingMessages,
          plan.maxPromptTokens,
          { extraMessages: toolDefinitionMessages }
        );
        if (!trimmed) {
          send(ws, {
            type: "error",
            requestId,
            code: "REQUEST_TOO_LARGE",
            message: "This conversation is too large to send.",
          });
          deleteActiveRequest(requestId);
          return;
        }
        state.workingMessages = trimmed;
        estPromptTokens = estimateTokensFromMessages([
          ...state.workingMessages,
          ...toolDefinitionMessages,
        ]);
      }

      if (quotaApplies) {
        const usage = await getUsageRow(db, ownerType, ownerKey);
        const remainingTokens = computeRemainingTokens(
          usage.tokens_used,
          dailyLimit
        );

        // Hard daily stop. Once the day is spent, no further requests start.
        if (remainingTokens <= 0) {
          const quota = createQuotaSnapshot({
            applies: true,
            tokensUsed: usage.tokens_used,
            dailyLimit,
          });
          sendQuotaError(ws, {
            requestId,
            code: "QUOTA_EXHAUSTED",
            message: DAILY_TOKEN_LIMIT_REACHED_MESSAGE,
            quota,
          });
          deleteActiveRequest(requestId);
          return;
        }

        // Admission happens once, on the first round. A request is served to
        // completion as long as the day is not already spent; later tool rounds
        // are never killed by a fresh quota read. The reservation below clamps
        // to the remaining budget (the atomic guard stays the race-proof daily
        // stop), and reconciliation with provider usage lands the final total.
        // That means the last request of the day may end slightly over the
        // limit; the next request then sees remainingTokens === 0 and stops.
        if ((state.round || 0) === 0) {
          const maxCompletionTokens = Math.min(
            plan.maxCompletionTokens,
            LAST_REQUEST_COMPLETION_TOKENS
          );
          const reserveTokens = Math.max(
            1,
            Math.min(
              remainingTokens,
              estPromptTokens + maxCompletionTokens
            )
          );
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
            deleteActiveRequest(requestId);
            return;
          }

          maxTokensForThisRound = maxCompletionTokens;
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
            estPromptTokens,
            maxCompletionTokens: maxTokensForThisRound,
          });
        } else {
          // Already-admitted request: keep serving with the plan's completion
          // allowance; the round-0 reservation already accounted for the day.
          maxTokensForThisRound = plan.maxCompletionTokens;
        }
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
        one = await streamOpenAIOnceFn({
          ws,
          send,
          requestId,
          model,
          messages: state.workingMessages,
          controller,
          // maxTokens: maxTokensForThisRequest,
          maxTokens: maxTokensForThisRound,
          tools: toolPolicy.tools,
          toolChoice: toolPolicy.toolChoice,
          parallelToolCalls: toolPolicy.parallelToolCalls,
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
        deleteActiveRequest(requestId);
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
        deleteActiveRequest(requestId);
        return;
      }

      if ((state.round || 0) >= MAX_TOOL_ROUNDS) {
        send(ws, {
          type: "error",
          requestId,
          code: "TOOL_ROUND_LIMIT",
          message: "The request used too many consecutive tool rounds.",
        });
        deleteActiveRequest(requestId);
        return;
      }

      // Tool calls required
      state.awaitingTools = true;
      state.acceptingClientToolResults = false;
      state.toolCalls = one.toolCalls || [];
      if (
        state.recipeFollowUpAvailable &&
        state.toolCalls.some(
          (call) =>
            call?.function?.name === "proposeAddMissingIngredientsToShoppingList"
        )
      ) {
        state.recipeFollowUpUsed = true;
      }
      const recipeRecommendationCall = state.toolCalls.find(
        (call) => call?.function?.name === "recommendRecipes"
      );
      const preferenceProposalCall = state.toolCalls.find(
        (call) => call?.function?.name === "proposeRecipePreferenceUpdate"
      );
      const fridgeProposalCall = state.toolCalls.find(
        (call) => call?.function?.name === "proposeAddAllToFridge"
      );
      const isolatedToolCall =
        recipeRecommendationCall || preferenceProposalCall || fridgeProposalCall;
      if (isolatedToolCall) {
        state.toolsLockedAfterIsolatedAction = true;
      }
      if (recipeRecommendationCall) {
        // A recommendation result must be formatted next, never followed by a
        // second search. One shopping-list follow-up is allowed after it.
        state.intent = "recipe_recommendation";
        state.recipeFollowUpAvailable = true;
      }
      state.collectedToolMsgs = [];
      state.clientToolCallIds = new Set();
      state.round = (state.round || 0) + 1;

      let { serverCalls, clientCalls } = splitToolCalls(state.toolCalls);
      if (isolatedToolCall) {
        const skippedCalls = state.toolCalls.filter(
          (call) => call !== isolatedToolCall
        );
        ({ serverCalls, clientCalls } = splitToolCalls([isolatedToolCall]));
        state.collectedToolMsgs.push(
          ...skippedCalls
            .filter((call) => call?.id)
            .map((call) => ({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                skipped: true,
                reason:
                  "Recipe and preference actions are isolated from other tool actions.",
              }),
            }))
        );
      }

      // ✅ HYBRID: run server tools immediately (e.g., webSearch)
      if (serverCalls.length) {
        try {
          const serverToolMsgs = await withAbortDeadline({
            parentSignal: state.controller.signal,
            timeoutMs: serverToolTimeoutMs,
            message: "Server tool execution timed out.",
            operation: (toolSignal) =>
              runToolCallsFn(serverCalls, {
                requestId,
                isAuthed: state.isAuthed,
                signal: toolSignal,
                wsSend: (obj) => {
                  if (
                    toolSignal.aborted ||
                    active.get(requestId) !== state
                  ) {
                    return false;
                  }
                  return send(ws, obj);
                },
                userId: state.userId,
                db: state.db,
                ownerType: state.ownerType,
                ownerKey: state.ownerKey,
                recipeContext: state.recipeContext,
              }),
          });
          if (active.get(requestId) !== state) return;
          state.collectedToolMsgs.push(
            ...(Array.isArray(serverToolMsgs) ? serverToolMsgs : [])
          );
        } catch (e) {
          if (active.get(requestId) !== state) throw e;
          send(ws, {
            type: "error",
            requestId,
            code:
              e?.code === "SERVER_TOOL_TIMEOUT"
                ? "SERVER_TOOL_TIMEOUT"
                : "SERVER_TOOL_ERROR",
            message: e?.message || "Server tool execution failed.",
          });
          deleteActiveRequest(requestId, { abort: true });
          return;
        }
      }

      // ✅ HYBRID: if there are client tools, request tool_results for ONLY those
      if (clientCalls.length) {
        state.clientToolCallIds = new Set(
          clientCalls.map((call) => call?.id).filter(Boolean)
        );
        state.acceptingClientToolResults = true;

        if (state.pendingToolResults) {
          const pendingToolResults = state.pendingToolResults;
          state.pendingToolResults = null;
          acceptClientToolResults(requestId, state, pendingToolResults);
          if (
            active.get(requestId) !== state ||
            !state.awaitingTools
          ) {
            return;
          }
        }

        const remainingClientCalls = clientCalls.filter(
          (call) => !state.receivedClientToolCallIds.has(call?.id)
        );
        if (remainingClientCalls.length === 0) {
          maybeResumeAfterTools(requestId);
          return;
        }
        send(ws, {
          type: "tool_calls",
          requestId,
          round: state.round,
          toolOwner: "client",
          toolCalls: remainingClientCalls,
        });

        // Start the timeout before consuming buffered results. A buffered or
        // later response may contain only some tool IDs; only the complete path
        // in maybeResumeAfterTools is allowed to clear this timer.
        if (state.toolResultsTimeout) clearTimeout(state.toolResultsTimeout);
        state.toolResultsTimeout = setTimeout(() => {
          const s2 = active.get(requestId);
          if (!s2) return;
          if (s2.awaitingTools) {
            send(ws, {
              type: "error",
              requestId,
              code: "TOOL_RESULTS_TIMEOUT",
              message: "Timed out waiting for tool results from client.",
            });
            deleteActiveRequest(requestId);
          }
        }, toolResultsTimeoutMs);

        return; // wait for client tool_results
      }

      // ✅ HYBRID: server-only tool calls -> resume immediately
      maybeResumeAfterTools(requestId);
    }

    async function handleMessage(raw) {
      const parsed = safeJsonParse(raw.toString());
      if (!parsed.ok) return send(ws, { type: "error", message: "Invalid JSON" });

      const msg = parsed.value;
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        return send(ws, {
          type: "error",
          code: "INVALID_REQUEST",
          message: "WebSocket messages must be JSON objects.",
        });
      }

      // Cancel
      if (msg.type === "cancel") {
        const requestId = msg.requestId;
        const pendingStart = starting.get(requestId);
        deleteActiveRequest(requestId, { abort: true });
        if (pendingStart) {
          pendingStart.cancelled = true;
          pendingStart.controller.abort();
        }
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
          deleteActiveRequest(requestId, { abort: true });
          return send(ws, {
            type: "error",
            requestId,
            code: "INVALID_REQUEST",
            message: "tool_results is invalid or too complex.",
          });
        }

        const novelResults = (msg.results || []).filter((result) => {
          const id = result?.tool_call_id || result?.id;
          return !state.receivedClientToolCallIds.has(id);
        });
        if (novelResults.length === 0) return;

        // A result can arrive before ownership is published only from an older
        // client/gateway pairing. Buffer it, then validate its IDs against the
        // client-owned set once server tools have settled.
        if (!state.acceptingClientToolResults) {
          const pending = [
            ...(state.pendingToolResults || []),
            ...novelResults,
          ];
          if (
            pending.length > MAX_CHAT_MESSAGES ||
            !validatePayloadComplexity(pending)
          ) {
            deleteActiveRequest(requestId, { abort: true });
            return send(ws, {
              type: "error",
              requestId,
              code: "INVALID_REQUEST",
              message: "Too many early tool results were received.",
            });
          }
          state.pendingToolResults = pending;
          send(ws, {
            type: "queued_tool_results",
            requestId,
            message: "Received tool_results early; queued until server is ready.",
          });
          return;
        }

        acceptClientToolResults(requestId, state, novelResults);
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

      if (active.has(requestId) || starting.has(requestId)) {
        send(ws, {
          type: "error",
          requestId,
          code: "DUPLICATE_REQUEST_ID",
          message: "A request with this requestId is already active.",
        });
        return;
      }

      const releasePendingStart = acquirePendingChatStartSlot(
        pendingStartsForConnection
      );
      if (!releasePendingStart) {
        send(ws, {
          type: "error",
          requestId,
          code: "CHAT_BUSY",
          message: "Too many chat requests are starting. Try again shortly.",
          retryAfterMs: 1_000,
        });
        return;
      }
      pendingStartsForConnection += 1;

      const pendingStart = {
        cancelled: false,
        controller: new AbortController(),
      };
      starting.set(requestId, pendingStart);

      try {

      if (!msg.token) {
        send(ws, {
          type: "error",
          requestId,
          code: "AUTH_REQUIRED",
          message: "Sign in is required to use chat.",
        });
        return;
      }

      let signedDecoded;
      try {
        signedDecoded = await verifySignedTokenFn(msg.token);
        if (!signedDecoded?.uid) throw new Error("Token is missing a UID");
      } catch {
        send(ws, {
          type: "error",
          requestId,
          code: "AUTH_INVALID",
          message: "Invalid token",
        });
        return;
      }

      const db = await getDbFn();
      const deletion = await getAccountDeletion(db, signedDecoded.uid);
      if (deletion) {
        send(ws, {
          type: "error",
          requestId,
          code:
            deletion.status === "complete"
              ? "ACCOUNT_DELETED"
              : "ACCOUNT_DELETION_IN_PROGRESS",
          message:
            deletion.status === "complete"
              ? "This account has been deleted."
              : "Account deletion is in progress.",
          ...publicAccountDeletion(deletion),
        });
        return;
      }

      let userId;
      try {
        const activeDecoded = await verifyActiveTokenFn(msg.token);
        if (!activeDecoded?.uid || activeDecoded.uid !== signedDecoded.uid) {
          throw new Error("Firebase token verification returned a different UID");
        }
        userId = activeDecoded.uid;
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
      if (
        msg.intent !== undefined &&
        msg.intent !== "chat" &&
        msg.intent !== "recipe_recommendation"
      ) {
        send(ws, {
          type: "error",
          requestId,
          code: "INVALID_REQUEST",
          message: "intent must be 'chat' or 'recipe_recommendation'.",
        });
        return;
      }
      const intent = normalizeChatIntent(msg.intent);
      const recipeContext = sanitizeRecipeContext(msg.recipeContext);

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

      if (pendingStart.cancelled) return;
      const controller = pendingStart.controller;
      const releaseConcurrency = acquireChatRequestSlot(userId);
      if (!releaseConcurrency) {
        send(ws, {
          type: "error",
          requestId,
          code: "CHAT_BUSY",
          message: "Too many chat requests are already running. Try again shortly.",
          retryAfterMs: 1_000,
        });
        return;
      }

      // Store full state for hybrid tool execution
      active.set(requestId, {
        controller,
        releaseConcurrency,
        workingMessages: [
          { role: "system", content: `Reply in ${language}.` },
          ...messages,
        ],
        model,
        language,
        intent,
        recipeContext,
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
        toolsLockedAfterIsolatedAction: false,
        recipeFollowUpAvailable: false,
        recipeFollowUpUsed: false,

        awaitingTools: false,
        acceptingClientToolResults: false,
        toolCalls: [],
        collectedToolMsgs: [],
        clientToolCallIds: new Set(),
        receivedClientToolCallIds: new Set(),
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

      launchRound(requestId);
      } finally {
        starting.delete(requestId);
        pendingStartsForConnection = Math.max(
          0,
          pendingStartsForConnection - 1
        );
        releasePendingStart();
      }
    }

    ws.on("message", (raw) => {
      if (draining || connectionClosed) {
        send(ws, {
          type: "error",
          code: "SERVER_DRAINING",
          message: "The server is restarting. Reconnect shortly.",
        });
        return;
      }

      trackOperation(
        handleMessage(raw).catch((error) => {
          console.error("[WebSocket message handler]", {
            name: String(error?.name || "Error"),
            code: error?.code ? String(error.code) : null,
          });
          send(ws, {
            type: "error",
            code: "INTERNAL_ERROR",
            message: "The WebSocket request could not be processed.",
          });
        })
      );
    });

    ws.on("close", () => {
      connectionClosed = true;
      for (const pendingStart of starting.values()) {
        pendingStart.cancelled = true;
        pendingStart.controller.abort();
      }
      starting.clear();
      for (const requestId of [...active.keys()]) {
        deleteActiveRequest(requestId, { abort: true });
      }
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

  return {
    beginDrain() {
      draining = true;
    },
    waitForIdle,
  };
}
