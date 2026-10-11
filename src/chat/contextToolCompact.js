// src/chat/contextToolCompact.js
//
// Shrinks the fridge read that opens a recipe-mode turn.
//
// Recipe mode forces a two-step ladder — read the fridge, then recommend — and
// everything the first step returns is carried in every later round's prompt.
// The client's getFridgeContents answers with each item's full stored shape,
// which measured ~135 tokens per item: a 150-item fridge costs ~20k prompt
// tokens, and that is paid again on the following round.
//
// None of that detail is usable by the recipe round. recommendRecipes builds
// its own inventory from the recipeContext the client already sends (names and
// quantities, capped at 100), and the round allowlist means no other tool can
// run in a recipe turn, so the ids and dates the model receives are dead
// weight. Names are all it needs to confirm the fridge and phrase its
// mustUseIngredients.
//
// Deliberately narrow: one tool, one mode. Every other reader — fridge edits,
// expiry questions, shopping-list work — keeps the untouched payload, because
// those flows resolve items by id and reason about expiresAt and urgency tags.

import { safeJsonParse } from "../utils/json.js";
import { GET_FRIDGE_CONTENTS_TOOL_NAME } from "./toolNames.js";

// The tools whose result is a fridge read in recipe mode. Reaching this set from
// anything other than the forced recipe read would need a new entry AND a
// matching round policy, which is why the caller pairs the name check with the
// round gate.
const RECIPE_READ_TOOL_NAMES = new Set([GET_FRIDGE_CONTENTS_TOOL_NAME]);

/** True for the fridge read that opens a recipe-mode turn. */
export function isRecipeReadToolName(toolName) {
  return RECIPE_READ_TOOL_NAMES.has(toolName);
}

/**
 * Reduce a fridge read to item names.
 *
 * Returns the input untouched when the tool is not the fridge read, when the
 * payload is not the expected `{ items: [...] }` shape (an error result, for
 * example), or when it cannot be parsed at all: a compaction that guessed
 * would hand the model a payload it never produced.
 */
export function compactContextToolContent(toolName, content) {
  if (!isRecipeReadToolName(toolName)) return content;
  if (typeof content !== "string") return content;

  const parsed = safeJsonParse(content);
  if (!parsed.ok) return content;

  const value = parsed.value;
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) {
    return content;
  }

  const items = [];
  for (const item of value.items) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (name) items.push({ name });
  }

  // Built from scratch rather than spread from the input: the whole point of
  // this module is that the payload cannot grow back into the transcript.
  return JSON.stringify({ __context: true, items });
}
