// Reduces a recommendRecipes result to the fields the chat model needs to
// format a suggestion list, so large instruction/ingredient payloads never
// inflate a user's chat token usage. The REST contract keeps the rich result;
// callers opt into this compact view only for model tool messages.

export function compactRecipeResultsForChat(result) {
  if (!result || typeof result !== "object") return result;
  const recipes = Array.isArray(result.recipes) ? result.recipes : [];
  return {
    recipes: recipes.map((recipe) => ({
      title: recipe.title,
      url: recipe.url,
      source: recipe.source,
      caloriesPerServing: recipe.caloriesPerServing,
      nutritionConfidence: recipe.nutritionConfidence,
      totalMinutes: recipe.totalMinutes,
      timeConfidence: recipe.timeConfidence,
      usedIngredients: recipe.usedIngredients,
      missingIngredients: recipe.missingIngredients,
      matchedRequestedIngredients: recipe.matchedRequestedIngredients,
      unmatchedRequestedIngredients: recipe.unmatchedRequestedIngredients,
      whyRecommended: recipe.whyRecommended,
      warnings: recipe.warnings,
    })),
    warnings: result.warnings,
    meta: result.meta,
  };
}
