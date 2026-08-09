import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import {
  getUsageRow,
  reconcileUsageReservation,
  reserveUsage,
} from "../src/usage/usageStore.js";

async function openUsageDb(t) {
  const db = await open({
    filename: ":memory:",
    driver: sqlite3.Database,
  });
  t.after(() => db.close());

  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  return db;
}

test("atomically rejects concurrent reservations beyond the daily limit", async (t) => {
  const db = await openUsageDb(t);
  const reservations = await Promise.all([
    reserveUsage(db, "user", "free-user", 600, 1_000),
    reserveUsage(db, "user", "free-user", 600, 1_000),
  ]);
  const accepted = reservations.filter(Boolean);
  const usage = await getUsageRow(db, "user", "free-user");

  assert.equal(accepted.length, 1);
  assert.equal(usage.tokens_used, 600);
});

test("reconciles a reservation to provider-reported usage", async (t) => {
  const db = await openUsageDb(t);
  const reservation = await reserveUsage(
    db,
    "user",
    "free-user",
    600,
    1_000
  );

  await reconcileUsageReservation(
    db,
    "user",
    "free-user",
    reservation,
    225,
    1
  );

  const usage = await getUsageRow(db, "user", "free-user");
  assert.deepEqual(usage, { tokens_used: 225, requests: 1 });
});

test("keeps the reservation when an interrupted stream has no usage", async (t) => {
  const db = await openUsageDb(t);
  const reservation = await reserveUsage(
    db,
    "trial",
    "device-id",
    400,
    1_000
  );

  await reconcileUsageReservation(
    db,
    "trial",
    "device-id",
    reservation,
    null,
    1
  );

  const usage = await getUsageRow(db, "trial", "device-id");
  assert.deepEqual(usage, { tokens_used: 400, requests: 1 });
});

test("releases a reservation for a rejected upstream request", async (t) => {
  const db = await openUsageDb(t);
  const reservation = await reserveUsage(
    db,
    "user",
    "free-user",
    300,
    1_000
  );

  await reconcileUsageReservation(
    db,
    "user",
    "free-user",
    reservation,
    0,
    0
  );

  const usage = await getUsageRow(db, "user", "free-user");
  assert.deepEqual(usage, { tokens_used: 0, requests: 0 });
});

test("an unexpected provider overage exhausts subsequent quota", async (t) => {
  const db = await openUsageDb(t);
  const reservation = await reserveUsage(
    db,
    "user",
    "free-user",
    200,
    1_000
  );

  await reconcileUsageReservation(
    db,
    "user",
    "free-user",
    reservation,
    1_100,
    1
  );

  const nextReservation = await reserveUsage(
    db,
    "user",
    "free-user",
    1,
    1_000
  );
  const usage = await getUsageRow(db, "user", "free-user");

  assert.equal(nextReservation, null);
  assert.deepEqual(usage, { tokens_used: 1_100, requests: 1 });
});
