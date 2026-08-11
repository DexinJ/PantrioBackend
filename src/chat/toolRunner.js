// src/chat/toolRunner.js
import { TOOLS } from "./tools.js";
import { TRIAL_ALLOWED_TOOLS } from "../config/policy.js";
import { safeJsonParse } from "../utils/json.js";

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Tool execution was aborted.", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  error.code = "TOOL_EXECUTION_ABORTED";
  throw error;
}

export async function runToolCalls(toolCalls, ctx, { tools = TOOLS } = {}) {
  const toolMessages = [];

  for (const tc of toolCalls) {
    throwIfAborted(ctx?.signal);
    const toolName = tc?.function?.name;
    const rawArgs = tc?.function?.arguments || "{}";
    const toolId = tc?.id;

    // Trial tool restrictions
    if (!ctx.isAuthed && toolName && !TRIAL_ALLOWED_TOOLS.has(toolName)) {
      const result = { error: "Trial: tool not available. Please sign in." };
      ctx.wsSend({ type: "tool", requestId: ctx.requestId, name: toolName, args: null, result });

      toolMessages.push({
        role: "tool",
        tool_call_id: toolId,
        content: JSON.stringify(result),
      });
      continue;
    }

    if (!toolName || !tools[toolName]) {
      const result = { error: `Tool not allowed: ${toolName}` };
      ctx.wsSend({ type: "tool", requestId: ctx.requestId, name: toolName || "unknown", args: null, result });

      toolMessages.push({
        role: "tool",
        tool_call_id: toolId,
        content: JSON.stringify(result),
      });
      continue;
    }

    const parsedArgs = safeJsonParse(rawArgs);
    const args = parsedArgs.ok ? parsedArgs.value : {};

    let result;
    try {
      result = await tools[toolName](args, ctx);
      throwIfAborted(ctx?.signal);
    } catch (e) {
      throwIfAborted(ctx?.signal);
      result = { error: e?.message || "Tool execution failed" };
    }

    throwIfAborted(ctx?.signal);
    ctx.wsSend({ type: "tool", requestId: ctx.requestId, name: toolName, args, result });

    toolMessages.push({
      role: "tool",
      tool_call_id: toolId,
      content: JSON.stringify(result),
    });
  }

  return toolMessages;
}
