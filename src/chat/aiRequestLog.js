// src/chat/aiRequestLog.js
//
// Opt-in logging for what the backend sends to the AI provider on a client's
// behalf. It is off unless LOG_AI_REQUESTS is set to a truthy value, and it
// redacts image payloads and truncates long text so a request log never
// becomes an unbounded mirror of user or image data.

import { LOG_AI_REQUESTS } from "../config/env.js";

const MAX_TEXT_CHARS = 4_000;
const MAX_IMAGE_URL_CHARS = 300;

function truncate(value, maxLength) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…[truncated]`;
}

function imagePlaceholder(value) {
  const url = typeof value === "string" ? value : "";
  if (!url) return "[image]";
  if (/^data:/i.test(url)) return "[image:data-uri]";
  return `[image:${truncate(url, MAX_IMAGE_URL_CHARS)}]`;
}

function sanitizeContentPart(part) {
  if (typeof part === "string") return truncate(part, MAX_TEXT_CHARS);
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return truncate(JSON.stringify(part), MAX_TEXT_CHARS);
  }

  const type = typeof part.type === "string" ? part.type : "";
  const isImage =
    type === "input_image" || type === "image_url" || type === "image_uri";
  if (isImage) {
    const raw =
      part.image_url?.url ??
      part.image_url ??
      part.imageUri ??
      part.imageUrl ??
      "";
    return { type: "input_image", image_url: imagePlaceholder(raw) };
  }

  if (typeof part.text === "string") {
    return { type: type || "text", text: truncate(part.text, MAX_TEXT_CHARS) };
  }

  return truncate(JSON.stringify(part), MAX_TEXT_CHARS);
}

function sanitizeContent(content) {
  if (typeof content === "string") return truncate(content, MAX_TEXT_CHARS);
  if (Array.isArray(content)) {
    const parts = content.map(sanitizeContentPart).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (content === undefined || content === null) return undefined;
  return truncate(JSON.stringify(content), MAX_TEXT_CHARS);
}

function sanitizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return undefined;
  return toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== "object") return toolCall;
    const fn = toolCall.function;
    return {
      ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
      ...(typeof toolCall.type === "string" ? { type: toolCall.type } : {}),
      ...(fn && typeof fn === "object"
        ? {
            function: {
              ...(typeof fn.name === "string" ? { name: fn.name } : {}),
              ...(typeof fn.arguments === "string"
                ? { arguments: truncate(fn.arguments, MAX_TEXT_CHARS) }
                : {}),
            },
          }
        : {}),
    };
  });
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const content = sanitizeContent(message.content);
  const toolCalls = sanitizeToolCalls(message.tool_calls);
  const out = {};
  if (typeof message.role === "string") out.role = message.role;
  if (content !== undefined) out.content = content;
  if (typeof message.name === "string") out.name = message.name;
  if (typeof message.tool_call_id === "string") {
    out.tool_call_id = message.tool_call_id;
  }
  if (toolCalls !== undefined) out.tool_calls = toolCalls;
  return out;
}

/**
 * Returns a bounded, image-free view of a Chat Completions message array.
 */
export function sanitizeMessagesForLog(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(sanitizeMessage)
    .filter(Boolean);
}

/**
 * Emits one JSON line describing an AI request. No-op unless enabled.
 * `enabled` and `logger` are overridable so tests can assert without env.
 */
export function logAiRequest(
  entry,
  { enabled = LOG_AI_REQUESTS, logger = console.log } = {}
) {
  if (!enabled) return;

  const {
    requestId = "",
    uid = "",
    model = "",
    round = 0,
    intent = "",
    messages = [],
  } = entry || {};

  logger(
    JSON.stringify({
      event: "pantrio_ai_request",
      timestamp: new Date().toISOString(),
      requestId,
      uid,
      model,
      round: Number.isInteger(round) ? round : 0,
      intent,
      messages: sanitizeMessagesForLog(messages),
    })
  );
}
