// src/chat/responsesStream.js
//
// Streaming transport for the Responses API. This mirrors `streamOpenAIOnce`
// so the gateway can swap endpoints behind a capability flag: same call
// signature, same normalized result shape, same WebSocket events.
//
// Differences from the Chat Completions transport:
//   - the request body is `input` items plus optional `instructions`
//   - usage arrives on the `response.completed` event rather than a trailing
//     chunk with `stream_options.include_usage`
//   - streaming uses typed events. `response.completed` carries the complete
//     `output` array, so tool calls are read from there instead of being
//     reassembled from deltas.
//   - `store: false` keeps responses out of OpenAI's 30-day retention, which
//     means reasoning items come back with `encrypted_content` and must be
//     replayed by the caller.

import { OPENAI_API_KEY } from "../config/env.js";
import { safeJsonParse } from "../utils/json.js";
import {
  toResponsesToolChoice,
  toResponsesTools,
} from "./responsesAdapter.js";
import { withAbortTimeout } from "./openaiStream.js";
import { normalizeUsage } from "./usageShape.js";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

/**
 * Normalize a Responses `function_call` item into the Chat-shaped tool call the
 * gateway (and the mobile client) already understand. `call_id` becomes the
 * exposed id so tool results round-trip back as `function_call_output.call_id`.
 */
function toChatToolCall(item) {
  const callId = item?.call_id || item?.id || null;
  if (!callId || !item?.name) return null;
  return {
    id: callId,
    type: "function",
    function: {
      name: item.name,
      arguments:
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
    },
  };
}

export async function streamResponsesOnce({
  ws,
  send,
  requestId,
  model,
  input,
  instructions,
  controller,
  maxTokens,
  timeoutMs = 120_000,
  reasoning = null,
  tools = [],
  toolChoice = "auto",
  parallelToolCalls = false,
  store = false,
  explicitCache = false,
}) {
  return withAbortTimeout(controller, timeoutMs, async () => {
    const t0 = Date.now();
    const responsesTools = toResponsesTools(tools);
    const hasTools = responsesTools.length > 0;
    const normalizedInstructions =
      typeof instructions === "string" ? instructions.trim() : "";

    const resp = await fetch(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        stream: true,
        store,
        ...(normalizedInstructions ? { instructions: normalizedInstructions } : {}),
        ...(reasoning && typeof reasoning === "object" ? { reasoning } : {}),
        ...(hasTools
          ? {
              tools: responsesTools,
              tool_choice: toResponsesToolChoice(toolChoice),
              ...(typeof parallelToolCalls === "boolean"
                ? { parallel_tool_calls: parallelToolCalls }
                : {}),
            }
          : {}),
        ...(Number.isInteger(maxTokens) && maxTokens > 0
          ? { max_output_tokens: maxTokens }
          : {}),
        ...(explicitCache
          ? { prompt_cache_options: { mode: "explicit", ttl: "30m" } }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!resp.ok || !resp.body) {
      let detail = "";
      try {
        detail = await resp.text();
      } catch {
        detail = "";
      }
      console.error("[Responses stream] upstream request failed", {
        status: resp.status,
        detail: String(detail).slice(0, 500),
      });
      return {
        ok: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: `The AI service returned an error (${resp.status}).`,
        },
      };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let responseObject = null;
    let failure = null;
    let textProduced = false;
    let firstTokenAt = null;
    let lastToolProgressSignature = "";
    const streamedItems = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.replace(/^data:\s*/, "");
          if (!data || data === "[DONE]") continue;

          const parsed = safeJsonParse(data);
          if (!parsed.ok) continue;
          const event = parsed.value;
          const type = event?.type;

          if (type === "response.output_text.delta") {
            const delta = event?.delta;
            if (typeof delta === "string" && delta.length) {
              if (!textProduced) {
                textProduced = true;
                // Reported on the opt-in round-usage line rather than here.
                firstTokenAt = Date.now();
              }
              send(ws, { type: "delta", requestId, text: delta });
            }
            continue;
          }

          if (type === "response.output_item.done") {
            const item = event?.item;
            if (item && typeof item === "object") {
              streamedItems.push(item);
              if (item.type === "function_call" && item.name) {
                const signature = JSON.stringify([item.name]);
                if (signature !== lastToolProgressSignature) {
                  lastToolProgressSignature = signature;
                  send(ws, {
                    type: "tool_progress",
                    requestId,
                    toolNames: [item.name],
                  });
                }
              }
            }
            continue;
          }

          if (type === "response.completed") {
            responseObject = event?.response || null;
            continue;
          }

          if (type === "response.failed" || type === "error") {
            failure = event?.response?.error || event;
            continue;
          }
        }
      }
    }

    if (failure) {
      console.error("[Responses stream] upstream error event", {
        code: failure?.code || failure?.type || "unknown",
        message: String(failure?.message || "unknown").slice(0, 300),
      });
      return {
        ok: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: "The AI service could not complete the request.",
        },
      };
    }

    const outputItems =
      Array.isArray(responseObject?.output) && responseObject.output.length
        ? responseObject.output
        : streamedItems;
    const usage = normalizeUsage(responseObject?.usage);
    if (usage) send(ws, { type: "usage", requestId, usage });

    const toolCalls = outputItems
      .filter((item) => item?.type === "function_call")
      .map(toChatToolCall)
      .filter(Boolean);
    const status = responseObject?.status || "completed";
    const incomplete = status === "incomplete";

    return {
      ok: true,
      status,
      incomplete,
      incompleteReason: incomplete
        ? responseObject?.incomplete_details?.reason || "unknown"
        : null,
      responseId: responseObject?.id || null,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      needsTools: toolCalls.length > 0,
      toolCalls,
      outputItems,
      usage,
      textProduced,
      ttftMs: firstTokenAt ? firstTokenAt - t0 : null,
    };
  });
}
