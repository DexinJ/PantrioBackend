// src/chat/providerRouting.js
//
// Which AI provider is allowed to do a given piece of work.
//
//   pantrio — our own key and models. Every helper runs server-side.
//   custom — the user's own base URL, model and key. Helper work is executed
//            by the client, so no credential ever reaches this server.
//   apple  — Apple Intelligence on the device. Same client-side execution.
//
// Web search (Serper) is shared by all three and stays server-side.
//
// The protocol only carries the provider *kind*; credentials stay on the
// device. Unknown or malformed values fail closed to "pantrio" so an older
// client can never be mistaken for a BYO one.

export const PROVIDER_KINDS = Object.freeze(["pantrio", "custom", "apple"]);

export const PROVIDER_PANTRIO = "pantrio";

export function normalizeProvider(value) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";
  return {
    kind: PROVIDER_KINDS.includes(kind) ? kind : PROVIDER_PANTRIO,
  };
}

/** True when the user's own provider must do the model work. */
export function isByoProvider(value) {
  return normalizeProvider(value).kind !== PROVIDER_PANTRIO;
}

/**
 * Features that stay on our key. A BYO caller must be refused rather than
 * silently served by pantrio, which is what "make it unavailable" means here.
 */
export const BYO_UNSUPPORTED_FEATURES = Object.freeze([
  "transcription",
  "summarization",
]);

export function byoUnsupportedBody(feature) {
  return {
    code: "PROVIDER_NOT_SUPPORTED",
    error: `${feature} is not available with a custom AI provider.`,
  };
}
