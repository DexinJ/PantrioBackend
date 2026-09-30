#!/usr/bin/env node
/**
 * Ops tool for App Store chain ownership bindings.
 *
 * Read-only by default. Prints every binding with its classification so an
 * operator can see which chains are live, which are released (their owning
 * account was deleted), and which are unbound.
 *
 * `--apply --release-orphans` deletes ownership rows that have no live
 * subscription row and no live user token. That is only needed if you decide to
 * remove provenance records; the claim rules work without it.
 *
 * See docs/apple-subscription-claim-redesign.md sections 3 and 8.3.
 */
import path from "node:path";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const releaseOrphans = args.has("--release-orphans");
const force = args.has("--force");

const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
const databasePath = String(process.env.SQLITE_PATH || "./data.sqlite").trim();

if (nodeEnv !== "production" && !force) {
  console.error(
    `Refusing to run with NODE_ENV=${nodeEnv || "(unset)"}. Pass --force to override.`
  );
  process.exit(1);
}
if (apply && !releaseOrphans) {
  console.error("--apply requires --release-orphans; nothing else is writable.");
  process.exit(1);
}

const db = await open({ filename: databasePath, driver: sqlite3.Database });

try {
  console.log(`database: ${path.resolve(databasePath)}`);
  console.log(`NODE_ENV: ${nodeEnv || "(unset)"}`);

  const schemaRow = await db.get(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'apple_subscription_ownership'`
  );
  if (!schemaRow) {
    console.error(
      `No apple_subscription_ownership table in ${path.resolve(databasePath)}; ` +
        "point SQLITE_PATH at the initialized backend database."
    );
    process.exit(1);
  }

  // Deliberately read whole rows and join in JS. Correlated subqueries and
  // qualified column references were observed to fail ("no such column") on a
  // file database opened by a second process in some environments, and this
  // tool must not be blocked by that.
  const bindings = await db.all(
    "SELECT * FROM apple_subscription_ownership ORDER BY environment, first_verified_at"
  );
  const users = await db.all("SELECT * FROM users");
  const subscriptions = await db.all("SELECT * FROM apple_subscriptions");

  const tokenOwnerUid = new Map(
    users
      .filter((user) => user.apple_app_account_token)
      .map((user) => [String(user.apple_app_account_token).toLowerCase(), user.uid])
  );
  const chainOwnerUid = new Map(
    subscriptions.map((row) => [
      `${row.environment}:${row.original_transaction_id}`,
      row.firebase_uid,
    ])
  );
  const forDisplay = bindings.map((binding) => ({
    ...binding,
    live_owner_uid:
      tokenOwnerUid.get(String(binding.app_account_token).toLowerCase()) || null,
    live_subscription_uid:
      chainOwnerUid.get(
        `${binding.environment}:${binding.original_transaction_id}`
      ) || null,
  }));

  const classify = (binding) => {
    if (binding.live_subscription_uid) return "live-bound";
    if (binding.live_owner_uid) return "live-bound";
    return "released";
  };
  const classified = forDisplay.map((binding) => ({
    ...binding,
    classification: classify(binding),
  }));
  const orphans = classified.filter(
    (binding) => binding.classification === "released"
  );

  console.log(`bindings: ${classified.length} (released: ${orphans.length})`);
  for (const binding of classified) {
    console.log(
      [
        binding.classification.padEnd(11),
        binding.environment.padEnd(10),
        String(binding.original_transaction_id).padEnd(24),
        `token=${String(binding.app_account_token).slice(0, 8)}…`,
        `first_verified=${new Date(binding.first_verified_at).toISOString()}`,
        binding.live_subscription_uid
          ? `owner=${binding.live_subscription_uid}`
          : `owner=(none) token_owner=${binding.live_owner_uid || "(none)"}`,
      ].join("  ")
    );
  }

  if (!apply) {
    console.log("\ndry run: no changes written.");
    if (orphans.length) {
      console.log("pass --apply --release-orphans to delete released bindings.");
    }
  } else if (!orphans.length) {
    console.log("\nno released bindings to delete.");
  } else {
    const backupPath = `${databasePath}.backup-${Date.now()}`;
    await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await db.exec(`VACUUM INTO ${JSON.stringify(backupPath)}`);
    console.log(`backup: ${backupPath}`);

    let deleted = 0;
    for (const orphan of orphans) {
      const result = await db.run(
        `DELETE FROM apple_subscription_ownership
          WHERE environment = ?
            AND original_transaction_id = ?`,
        [orphan.environment, orphan.original_transaction_id]
      );
      deleted += Number(result?.changes || 0);
    }
    console.log(`deleted bindings: ${deleted}`);
  }

  const remaining = await db.all("SELECT * FROM apple_subscription_ownership");
  console.log(`retained provenance rows: ${remaining.length}`);
} finally {
  await db.close();
}
