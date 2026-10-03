// src/chat/recipeMethodGuard.js
//
// Detects method bullets that are too close to the publisher's own text.
//
// The summarizer prompt forbids copying, but a prompt is not enforcement. This
// computes an n-word shingle overlap between each generated bullet and the
// source steps, and drops anything above the threshold.
//
// Scope, stated honestly: this catches VERBATIM reuse. A synonym-level rewrite
// of every step still passes, and a cross-language summary shares no shingles
// with the source at all. The primary controls are the prompt, the small bullet
// budget, and the link back to the source page; this is the last line that stops
// the most obvious failure mode.

export const METHOD_SHINGLE_WORDS = 6;
export const METHOD_OVERLAP_THRESHOLD = 0.4;

function words(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingleSet(value, size) {
  const tokens = words(value);
  const output = new Set();
  if (tokens.length < size) return output;
  for (let index = 0; index + size <= tokens.length; index += 1) {
    output.add(tokens.slice(index, index + size).join(" "));
  }
  return output;
}

/**
 * Fraction of the candidate's shingles that also appear in the source. A
 * candidate shorter than `size` words has no shingles and scores 0 — it is too
 * short to carry copied expression.
 */
export function shingleOverlap(
  candidate,
  sourceText,
  size = METHOD_SHINGLE_WORDS
) {
  const candidateShingles = shingleSet(candidate, size);
  if (candidateShingles.size === 0) return 0;
  const source = shingleSet(sourceText, size);
  if (source.size === 0) return 0;
  let shared = 0;
  for (const shingle of candidateShingles) {
    if (source.has(shingle)) shared += 1;
  }
  return shared / candidateShingles.size;
}

/**
 * Keeps only the bullets that are sufficiently rewritten. With no source text
 * there is nothing to compare against, so the bullets are kept as-is rather
 * than silently dropped.
 */
export function filterOriginalMethod(
  bullets,
  sourceText,
  {
    size = METHOD_SHINGLE_WORDS,
    threshold = METHOD_OVERLAP_THRESHOLD,
  } = {}
) {
  const list = Array.isArray(bullets) ? bullets : [];
  const source = String(sourceText || "").trim();
  if (!source) return list.slice();
  return list.filter(
    (bullet) => shingleOverlap(bullet, source, size) <= threshold
  );
}

/**
 * Applies the guard in place across a recipe list, using the recipe's own
 * publisher steps as the comparison source. Returns the number of bullets kept.
 */
export function enforceMethodOriginality(
  recipes,
  { size = METHOD_SHINGLE_WORDS, threshold = METHOD_OVERLAP_THRESHOLD } = {}
) {
  let kept = 0;
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    if (!Array.isArray(recipe?.method) || recipe.method.length === 0) continue;
    const source = [
      ...(recipe.instructions || []),
      recipe.description || "",
    ].join(" ");
    recipe.method = filterOriginalMethod(recipe.method, source, {
      size,
      threshold,
    });
    kept += recipe.method.length;
  }
  return kept;
}
