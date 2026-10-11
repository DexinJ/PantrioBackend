// src/chat/messageTrimmer.js

import { estimateTokensFromMessages } from "../usage/tokenBudget.js";

/**
 * Locate complete tool-round segments in a Chat Completions message list.
 * A segment is an assistant message carrying tool_calls followed by the
 * consecutive tool messages that answer every one of those calls. Segments
 * are returned oldest-first by start index.
 */
export function findToolRoundSegments(messages) {
  const segments = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      message?.role !== "assistant" ||
      !Array.isArray(message?.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      continue;
    }

    const ids = new Set(
      message.tool_calls.map((call) => call?.id).filter(Boolean)
    );
    if (ids.size === 0) continue;

    let lastToolIndex = -1;
    let covered = 0;
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      if (ids.has(messages[j].tool_call_id)) {
        covered += 1;
        lastToolIndex = j;
      }
      j += 1;
    }

    if (covered === ids.size && lastToolIndex > i) {
      segments.push({ start: i, end: lastToolIndex });
      i = lastToolIndex;
    }
  }

  return segments;
}

/**
 * Remove every complete tool-round segment whose calls all satisfy
 * `shouldDropCall`.
 *
 * A segment is removed whole — the assistant message carrying the calls and
 * every tool message answering them — because both transports reject a
 * dangling function_call_output. Segments with any call the predicate refuses
 * are left alone, so a round that mixed a retired read with a live action
 * survives intact.
 *
 * Returns the input array unchanged when nothing matches; otherwise returns a
 * new array. The input is never mutated.
 */
export function dropToolRoundSegments(messages, shouldDropCall) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (typeof shouldDropCall !== "function") return messages;

  const doomed = new Set();
  for (const segment of findToolRoundSegments(messages)) {
    const calls = messages[segment.start]?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    if (!calls.every((call) => shouldDropCall(call))) continue;
    for (let index = segment.start; index <= segment.end; index += 1) {
      doomed.add(index);
    }
  }

  if (doomed.size === 0) return messages;
  return messages.filter((_message, index) => !doomed.has(index));
}

/**
 * Drop the oldest complete tool-round segments until the estimated prompt
 * tokens fit under maxTokens. Extra messages (for example the serialized tool
 * definitions) are included in the estimate but are never trimmed.
 *
 * Returns the trimmed message list, or null when even the conversation
 * without tool segments still exceeds the cap. The system prompt and the
 * client's original messages are always preserved.
 */
export function trimWorkingMessagesToFit(
  messages,
  maxTokens,
  { extraMessages = [], estimate = estimateTokensFromMessages } = {}
) {
  if (!Array.isArray(messages)) return null;
  if (messages.length === 0) return [];

  const extra = Array.isArray(extraMessages) ? extraMessages : [];
  const fits = (msgs) => estimate([...msgs, ...extra]) <= maxTokens;

  if (fits(messages)) return messages;

  let current = messages;
  for (;;) {
    const segments = findToolRoundSegments(current);
    if (segments.length === 0) return null;

    const oldest = segments[0];
    current = [
      ...current.slice(0, oldest.start),
      ...current.slice(oldest.end + 1),
    ];

    if (fits(current)) return current;
  }
}
