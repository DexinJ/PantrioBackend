// src/chat/openaiStream.js
import { OPENAI_API_KEY } from "../config/env.js";
import { OPENAI_TOOLS } from "./tools.js";
import { safeJsonParse } from "../utils/json.js";

function upsertToolCalls(toolCallState, toolCallsDelta) {
  for (const tc of toolCallsDelta) {
    const idx = tc.index ?? 0;

    if (!toolCallState[idx]) {
      toolCallState[idx] = {
        id: tc.id || null,
        type: tc.type || "function",
        function: { name: tc.function?.name || "", arguments: "" },
      };
    }

    if (tc.id) toolCallState[idx].id = tc.id;
    if (tc.function?.name) toolCallState[idx].function.name = tc.function.name;

    if (typeof tc.function?.arguments === "string") {
      toolCallState[idx].function.arguments += tc.function.arguments;
    }
  }
}

/**
 * Stream one OpenAI call and forward deltas to ws.
 * If the model requests tools, this ALSO emits:
 *   { type:"tool_calls", requestId, toolCalls:[...] }
 *
 * Returns tool calls + usage (when include_usage enabled).
 */
export async function streamOpenAIOnce({
  ws,
  send,
  requestId,
  model,
  messages,
  controller,
  maxTokens,
}) {
  let firstTokenAt = null;
  const t0 = Date.now();
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
      ...(Number.isInteger(maxTokens) && maxTokens > 0
        ? { max_completion_tokens: maxTokens }
        : {}),
    }),
    signal: controller.signal,
  });
  


  if (!resp.ok || !resp.body) {
    const text = await resp.text();

    console.error("[OpenAI chat stream] upstream request failed", {
      status: resp.status,
      body: text,
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

  const toolCallState = [];
  let finishReason = null;
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const evtText of events) {
      const lines = evtText.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.replace(/^data:\s*/, "");
        if (!data) continue;
        if (data === "[DONE]") break;

        const parsed = safeJsonParse(data);
        if (!parsed.ok) continue;

        const evt = parsed.value;
        const choice = evt?.choices?.[0];

        // usage appears near the end when include_usage is enabled
        if (evt?.usage && typeof evt.usage.total_tokens === "number") {
          usage = evt.usage;
          send(ws, { type: "usage", requestId, usage });
        }

        const text = choice?.delta?.content;
        if (typeof text === "string" && text.length) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            console.log(
              `[OPENAI TTFT] ${firstTokenAt - t0} ms`
            );
          }
          send(ws, { type: "delta", requestId, text });
        }

        const toolCallsDelta = choice?.delta?.tool_calls;
        if (Array.isArray(toolCallsDelta) && toolCallsDelta.length) {
          upsertToolCalls(toolCallState, toolCallsDelta);

          // Keep your lightweight progress signal
          const names = toolCallState
            .map((t) => t?.function?.name)
            .filter(Boolean);
          if (names.length) {
            send(ws, { type: "tool_progress", requestId, toolNames: names });
          }
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  const toolCalls = toolCallState.filter(Boolean);
  const needsTools = finishReason === "tool_calls" && toolCalls.length > 0;
  console.log(toolCalls);
  // 🔥 NEW: emit the actual tool calls (name + id + accumulated args)
  if (needsTools) {
    send(ws, { type: "tool_calls", requestId, toolCalls });
  }

  return {
    ok: true,
    finishReason,
    needsTools,
    toolCalls,
    usage,
  };
}
