// src/telemetry/chatTrace.js
//
// Detached, debug-only request tracing for chat latency and prompt shape.
//
// To remove this instrumentation entirely:
//   1. Delete this file.
//   2. Delete the import and every call site in chatGateway.js and
//      openaiStream.js that references "createChatTrace" or "chat_trace".
// Nothing else depends on it.

// On by default in every environment; set TRACE_CHAT=0 to disable.
const ENABLED = process.env.TRACE_CHAT !== "0";

export function createChatTrace(meta = {}) {
  const stages = [];
  const startedAt = Date.now();
  const enabled = ENABLED;

  const span = (stage) => {
    if (!enabled) return () => {};
    const start = Date.now();
    return (extra = {}) => {
      stages.push({ stage, ms: Math.max(0, Date.now() - start), ...extra });
    };
  };

  const add = (stage, ms, extra = {}) => {
    if (!enabled) return;
    stages.push({
      stage,
      ms: Math.max(0, Math.round(Number(ms) || 0)),
      ...extra,
    });
  };

  return {
    enabled,
    span,
    add,
    snapshot() {
      if (!enabled) return null;
      return { meta, totalMs: Date.now() - startedAt, stages };
    },
  };
}
