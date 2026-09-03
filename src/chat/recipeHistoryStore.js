// Stores the URLs of recipes already shown to an owner so subsequent
// recommendations can avoid re-suggesting them (re-admitting only as a
// low-priority fallback when few new recipes are available).

const MAX_RECENT_URLS = 60;
const MAX_KEPT_URLS = 100;

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseOwner(owner, isAuthed = true) {
  return {
    ownerType: isAuthed ? "user" : "trial",
    ownerKey: owner,
  };
}

export async function getRecentRecipeUrls(
  db,
  owner,
  { limit = MAX_RECENT_URLS } = {}
) {
  if (!db || !owner?.ownerKey) return [];
  const rows = await db.all(
    `SELECT url
       FROM recipe_history
      WHERE owner_type = ? AND owner_key = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [owner.ownerType, owner.ownerKey, Math.max(1, Math.min(200, limit))]
  );
  return (rows || []).map((row) => row.url);
}

export async function pruneRecipeHistory(
  db,
  owner,
  { keep = MAX_KEPT_URLS } = {}
) {
  if (!db || !owner?.ownerKey) return;
  await db.run(
    `DELETE FROM recipe_history
      WHERE id NOT IN (
        SELECT id
          FROM recipe_history
         WHERE owner_type = ? AND owner_key = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
      )`,
    [owner.ownerType, owner.ownerKey, Math.max(1, keep)]
  );
}

export async function recordRecipeUrls(
  db,
  owner,
  recipes,
  { now = Date.now() } = {}
) {
  if (!db || !owner?.ownerKey || !Array.isArray(recipes)) return 0;
  let recorded = 0;
  for (const recipe of recipes) {
    const url = recipe?.url;
    if (!validHttpUrl(url)) continue;
    await db.run(
      `INSERT INTO recipe_history (owner_type, owner_key, url, title, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_key, url)
       DO UPDATE SET created_at = excluded.created_at, title = excluded.title`,
      [
        owner.ownerType,
        owner.ownerKey,
        url,
        String(recipe.title || "").slice(0, 180),
        now,
      ]
    );
    recorded += 1;
  }
  if (recorded > 0) await pruneRecipeHistory(db, owner);
  return recorded;
}
