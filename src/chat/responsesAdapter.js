// Converts the gateway's Chat-Completions-shaped transcript into Responses API
// input items.
//
// The gateway keeps building `{ role, content }` messages plus `tool_calls` /
// `role: "tool"` turns because that shape is shared with the Chat Completions
// path. The Responses API instead takes a flat list of typed items, so this
// module performs the translation at request time.
//
// Two shapes matter:
//   - Reasoning continuity: the raw output items of an earlier round (which
//     include `reasoning` items carrying `encrypted_content` when store is
//     false) are replayed verbatim instead of being reconstructed, because the
//     encrypted payload must survive untouched.
//   - Tool linkage: tool results are `function_call_output` items whose
//     `call_id` matches the originating `function_call` item.

const EXPLICIT_CACHE_BREAKPOINT = Object.freeze({ mode: "explicit" });

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function toUserItem(message) {
  if (typeof message.content === "string") {
    const text = message.content.trim();
    if (!text) return null;
    return { role: "user", content: [{ type: "input_text", text: message.content }] };
  }

  const parts = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!part || typeof part !== "object") continue;

    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string" &&
      part.text.length
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    // Chat Completions sends images as { type: "image_url", image_url: { url } };
    // Responses expects { type: "input_image", image_url: "<url-or-data-uri>" }.
    if (part.type === "image_url" && part.image_url) {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url.url;
      if (typeof url === "string" && url) {
        parts.push({ type: "input_image", image_url: url });
      }
      continue;
    }

    if (part.type === "input_image" && typeof part.image_url === "string" && part.image_url) {
      parts.push({ type: "input_image", image_url: part.image_url });
    }
  }

  return parts.length ? { role: "user", content: parts } : null;
}

function toAssistantItem(message) {
  const text = textFromContent(message.content).trim();
  if (!text) return null;
  return { role: "assistant", content: [{ type: "output_text", text }] };
}

function toFunctionCallItem(call) {
  const callId = call?.id || call?.call_id || null;
  if (!callId) return null;
  return {
    type: "function_call",
    call_id: callId,
    name: call?.function?.name || call?.name || "",
    arguments:
      typeof call?.function?.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call?.function?.arguments ?? call?.arguments ?? {}),
  };
}

function toFunctionCallOutputItem(message) {
  const callId = message?.tool_call_id || null;
  if (!callId) return null;
  const output =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? {});
  return { type: "function_call_output", call_id: callId, output };
}

/**
 * Map Chat Completions tool definitions to Responses tool definitions.
 * Chat nests the definition under `function`; Responses is internally tagged,
 * so the same fields sit at the top level.
 *
 * `strict` is intentionally omitted: Responses attempts strict mode when the
 * field is absent and falls back to best-effort calling (returning the resolved
 * tool with `strict: false`) when a schema is not strict-compatible. Setting it
 * explicitly would turn that graceful fallback into a hard failure.
 */
export function toResponsesTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const definition = tool?.function;
      if (!definition?.name) return null;
      return {
        type: "function",
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      };
    })
    .filter(Boolean);
}

/**
 * Map a Chat Completions tool_choice onto the Responses shape.
 *
 * Chat nests a pinned function under `function`; Responses is internally
 * tagged, so the name sits at the top level. The API rejects the nested form
 * with "Missing required parameter: 'tool_choice.name'.", which is exactly what
 * every forced recipe round hit. String forms ("auto" | "none" | "required")
 * and anything unrecognized pass through untouched rather than being guessed
 * at, so a future tool_choice variant cannot be silently rewritten.
 */
export function toResponsesToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }
  const name =
    typeof toolChoice?.function?.name === "string"
      ? toolChoice.function.name
      : typeof toolChoice.name === "string"
        ? toolChoice.name
        : "";
  return name ? { type: "function", name } : toolChoice;
}

/**
 * Build the Responses request payload from the gateway transcript.
 *
 * @param {object} options
 * @param {Array} options.messages Chat-shaped transcript (system/user/assistant/tool).
 * @param {Array} [options.roundOutputs] Raw output items per tool round, used to
 *   replay reasoning items that the Chat-shaped transcript cannot represent.
 * @param {boolean} [options.explicitCache] Attach an explicit cache breakpoint
 *   to the developer instructions. Top-level `instructions` cannot carry one.
 * @returns {{ instructions?: string, input: Array }}
 */
export function buildResponsesInput({
  messages,
  roundOutputs = [],
  explicitCache = false,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const roundsByCallId = new Map();
  for (const round of Array.isArray(roundOutputs) ? roundOutputs : []) {
    for (const callId of round?.callIds || []) {
      if (callId) roundsByCallId.set(callId, round);
    }
  }

  const systemParts = [];
  const replayedRounds = new Set();
  const input = [];

  for (const message of list) {
    if (!message || typeof message !== "object") continue;

    switch (message.role) {
      case "system": {
        const text = textFromContent(message.content).trim();
        if (text) systemParts.push(text);
        break;
      }
      case "user": {
        const item = toUserItem(message);
        if (item) input.push(item);
        break;
      }
      case "assistant": {
        const item = toAssistantItem(message);
        if (item) input.push(item);
        for (const call of Array.isArray(message.tool_calls)
          ? message.tool_calls
          : []) {
          const round = call?.id ? roundsByCallId.get(call.id) : null;
          if (round) {
            if (replayedRounds.has(round)) continue;
            replayedRounds.add(round);
            input.push(...(round.items || []));
            continue;
          }
          const functionCall = toFunctionCallItem(call);
          if (functionCall) input.push(functionCall);
        }
        break;
      }
      case "tool": {
        const item = toFunctionCallOutputItem(message);
        if (item) input.push(item);
        break;
      }
      default:
        break;
    }
  }

  const instructions = systemParts.join("\n\n").trim();
  if (!instructions) return { input };

  if (explicitCache) {
    return {
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: instructions,
              prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT,
            },
          ],
        },
        ...input,
      ],
    };
  }

  return { instructions, input };
}
