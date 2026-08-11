import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { createAppleSignInRuntime } from "../src/auth/appleSignInConfig.js";
import {
  AppleSignInError,
  assertRecentAppleAuthentication,
  decodedTokenHasAppleIdentity,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  linkAppleAuthorizationForUser,
  revokeAppleAuthorizationForUser,
  revokeAppleRefreshToken,
  shouldUseManualAppleRevocationFallback,
  verifyAppleIdentityToken,
} from "../src/auth/appleSignInService.js";
import { getAppleSignInCredential } from "../src/auth/appleSignInStore.js";

function validEnvironment() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    APPLE_SIGN_IN_CLIENT_ID: "com.chilltech.pantrio",
    APPLE_SIGN_IN_TEAM_ID: "TEAM123456",
    APPLE_SIGN_IN_KEY_ID: "KEY1234567",
    APPLE_SIGN_IN_PRIVATE_KEY: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64:
      randomBytes(32).toString("base64"),
    APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_ID: "test-v1",
  };
}

function runtime(fetchImpl = async () => {
  throw new Error("unexpected request");
}) {
  return createAppleSignInRuntime({ env: validEnvironment(), fetchImpl });
}

async function openDb(t) {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());
  const schema = await fs.readFile(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  await db.exec(schema);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('firebase-user', 'pantrio', 1, 1)`
  );
  return db;
}

function recentAppleToken(overrides = {}) {
  return {
    uid: "firebase-user",
    auth_time: Math.floor(Date.now() / 1_000),
    firebase: {
      sign_in_provider: "apple.com",
      identities: { "apple.com": ["apple-subject"] },
    },
    ...overrides,
  };
}

test("encrypts refresh tokens with binding-authenticated AES-GCM", () => {
  const activeRuntime = runtime();
  const binding = {
    uid: "firebase-user",
    clientId: activeRuntime.clientId,
    appleSubject: "apple-subject",
  };
  const first = encryptAppleRefreshToken("refresh-secret", binding, activeRuntime);
  const second = encryptAppleRefreshToken("refresh-secret", binding, activeRuntime);

  assert.notEqual(first, second);
  assert.equal(first.includes("refresh-secret"), false);
  assert.equal(
    decryptAppleRefreshToken(first, binding, activeRuntime),
    "refresh-secret"
  );
  assert.throws(
    () =>
      decryptAppleRefreshToken(
        first,
        { ...binding, uid: "different-user" },
        activeRuntime
      ),
    /could not be read/
  );
});

test("requires a recent Firebase Sign in with Apple session", () => {
  assert.throws(
    () =>
      assertRecentAppleAuthentication({
        auth_time: Math.floor(Date.now() / 1_000),
        firebase: { sign_in_provider: "google.com" },
      }),
    (error) => error.code === "APPLE_RECENT_AUTH_REQUIRED"
  );
  assert.throws(
    () =>
      assertRecentAppleAuthentication(
        recentAppleToken({ auth_time: 1_000 }),
        { nowMs: 2_000_000_000 }
      ),
    (error) => error.code === "APPLE_RECENT_AUTH_REQUIRED"
  );
});

test("links only the Apple subject already attached to the Firebase user", async (t) => {
  const db = await openDb(t);
  const activeRuntime = runtime();
  const result = await linkAppleAuthorizationForUser(db, {
    decoded: recentAppleToken(),
    authorizationCode: "one-time-code",
    runtime: activeRuntime,
    getFirebaseUserFn: async () => ({
      providerData: [{ providerId: "apple.com", uid: "apple-subject" }],
    }),
    exchangeAuthorizationCodeFn: async () => ({
      refresh_token: "refresh-secret",
      id_token: "signed-id-token",
    }),
    verifyIdentityTokenFn: async () => ({ sub: "apple-subject" }),
  });
  const saved = await getAppleSignInCredential(db, "firebase-user");

  assert.deepEqual(result, { linked: true });
  assert.equal(saved.apple_subject, "apple-subject");
  assert.equal(saved.client_id, "com.chilltech.pantrio");
  assert.equal(saved.encrypted_refresh_token.includes("refresh-secret"), false);
});

test("rejects an authorization code for a different Apple subject", async (t) => {
  const db = await openDb(t);
  await assert.rejects(
    linkAppleAuthorizationForUser(db, {
      decoded: recentAppleToken(),
      authorizationCode: "one-time-code",
      runtime: runtime(),
      getFirebaseUserFn: async () => ({
        providerData: [{ providerId: "apple.com", uid: "expected-subject" }],
      }),
      exchangeAuthorizationCodeFn: async () => ({
        refresh_token: "refresh-secret",
        id_token: "signed-id-token",
      }),
      verifyIdentityTokenFn: async () => ({ sub: "other-subject" }),
    }),
    (error) => error.code === "APPLE_IDENTITY_MISMATCH"
  );
  assert.equal(await getAppleSignInCredential(db, "firebase-user"), undefined);
});

test("does not bind one Apple identity to two Firebase accounts", async (t) => {
  const db = await openDb(t);
  await db.run(
    `INSERT INTO users (uid, username, created_at, updated_at)
     VALUES ('second-user', 'second', 1, 1)`
  );
  const activeRuntime = runtime();
  const commonOptions = {
    authorizationCode: "one-time-code",
    runtime: activeRuntime,
    getFirebaseUserFn: async () => ({
      providerData: [{ providerId: "apple.com", uid: "apple-subject" }],
    }),
    exchangeAuthorizationCodeFn: async () => ({
      refresh_token: "refresh-secret",
      id_token: "signed-id-token",
    }),
    verifyIdentityTokenFn: async () => ({ sub: "apple-subject" }),
  };

  await linkAppleAuthorizationForUser(db, {
    ...commonOptions,
    decoded: recentAppleToken(),
  });
  await assert.rejects(
    linkAppleAuthorizationForUser(db, {
      ...commonOptions,
      decoded: recentAppleToken({ uid: "second-user" }),
    }),
    (error) => error.code === "APPLE_IDENTITY_CONFLICT" && error.status === 409
  );
});

test("recognizes Apple as either the current or a linked Firebase provider", () => {
  assert.equal(decodedTokenHasAppleIdentity(recentAppleToken()), true);
  assert.equal(
    decodedTokenHasAppleIdentity({
      firebase: {
        sign_in_provider: "password",
        identities: { "apple.com": ["apple-subject"] },
      },
    }),
    true
  );
  assert.equal(
    decodedTokenHasAppleIdentity({
      firebase: { sign_in_provider: "password", identities: {} },
    }),
    false
  );
});

test("uses manual fallback for Apple failures so deletion is never blocked", () => {
  assert.equal(
    shouldUseManualAppleRevocationFallback({
      code: "APPLE_SIGN_IN_NOT_CONFIGURED",
    }),
    true
  );
  assert.equal(
    shouldUseManualAppleRevocationFallback(
      new AppleSignInError("APPLE_REQUEST_FAILED", "terminal", {
        retryable: false,
      })
    ),
    true
  );
  assert.equal(
    shouldUseManualAppleRevocationFallback(
      new AppleSignInError("APPLE_SERVICE_UNAVAILABLE", "retry", {
        retryable: true,
      })
    ),
    true
  );
  assert.equal(shouldUseManualAppleRevocationFallback(new Error("database")), false);
});

test("exchanges and revokes tokens with exact form-encoded Apple requests", async () => {
  const calls = [];
  const activeRuntime = runtime(async (url, init) => {
    calls.push({ url, init });
    const payload = url.endsWith("/auth/token")
      ? {
          refresh_token: "refresh-token",
          access_token: "access-token",
          id_token: "id-token",
        }
      : {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  });

  await exchangeAppleAuthorizationCode(activeRuntime, "code + slash/=");
  await revokeAppleRefreshToken(activeRuntime, "refresh-token");

  const exchangeBody = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, "https://appleid.apple.com/auth/token");
  assert.equal(exchangeBody.get("client_id"), "com.chilltech.pantrio");
  assert.equal(exchangeBody.get("code"), "code + slash/=");
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(exchangeBody.has("redirect_uri"), false);

  const revokeBody = new URLSearchParams(calls[1].init.body);
  assert.equal(calls[1].url, "https://appleid.apple.com/auth/revoke");
  assert.equal(revokeBody.get("token"), "refresh-token");
  assert.equal(revokeBody.get("token_type_hint"), "refresh_token");
});

test("treats Apple throttling as retryable for the deletion outbox", async () => {
  const activeRuntime = runtime(async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: "rate_limit_exceeded" }),
  }));

  await assert.rejects(
    revokeAppleRefreshToken(activeRuntime, "refresh-token"),
    (error) =>
      error.code === "APPLE_REQUEST_FAILED" &&
      error.status === 503 &&
      error.retryable === true
  );
});

test("verifies Apple's identity-token signature and claims against JWKS", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  Object.assign(publicJwk, { kid: "apple-test-key", alg: "RS256", use: "sig" });
  const identityToken = jwt.sign(
    { sub: "apple-subject" },
    privateKey,
    {
      algorithm: "RS256",
      keyid: "apple-test-key",
      issuer: "https://appleid.apple.com",
      audience: "com.chilltech.pantrio",
      expiresIn: 300,
    }
  );
  const activeRuntime = runtime(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ keys: [publicJwk] }),
  }));

  const claims = await verifyAppleIdentityToken(activeRuntime, identityToken);
  assert.equal(claims.sub, "apple-subject");
});

test("coalesces concurrent Apple JWKS cache misses", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  Object.assign(publicJwk, { kid: "shared-key", alg: "RS256", use: "sig" });
  const identityToken = jwt.sign(
    { sub: "apple-subject" },
    privateKey,
    {
      algorithm: "RS256",
      keyid: "shared-key",
      issuer: "https://appleid.apple.com",
      audience: "com.chilltech.pantrio",
      expiresIn: 300,
    }
  );
  let fetchCount = 0;
  const activeRuntime = runtime(async () => {
    fetchCount += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ keys: [publicJwk] }),
    };
  });

  const claims = await Promise.all(
    Array.from({ length: 5 }, () =>
      verifyAppleIdentityToken(activeRuntime, identityToken)
    )
  );
  assert.equal(fetchCount, 1);
  assert.deepEqual(claims.map((value) => value.sub), Array(5).fill("apple-subject"));
});

test("retains the revoked credential until account deletion commits", async (t) => {
  const db = await openDb(t);
  const activeRuntime = runtime();
  await linkAppleAuthorizationForUser(db, {
    decoded: recentAppleToken(),
    authorizationCode: "one-time-code",
    runtime: activeRuntime,
    getFirebaseUserFn: async () => ({
      providerData: [{ providerId: "apple.com", uid: "apple-subject" }],
    }),
    exchangeAuthorizationCodeFn: async () => ({
      refresh_token: "refresh-secret",
      id_token: "signed-id-token",
    }),
    verifyIdentityTokenFn: async () => ({ sub: "apple-subject" }),
  });

  let revokedToken = null;
  const result = await revokeAppleAuthorizationForUser(db, {
    uid: "firebase-user",
    runtime: activeRuntime,
    revokeRefreshTokenFn: async (_runtime, token) => {
      revokedToken = token;
      assert.ok(await getAppleSignInCredential(db, "firebase-user"));
    },
  });

  assert.deepEqual(result, { status: "revoked" });
  assert.equal(revokedToken, "refresh-secret");
  assert.ok(await getAppleSignInCredential(db, "firebase-user"));
  await db.run("DELETE FROM users WHERE uid = 'firebase-user'");
  assert.equal(await getAppleSignInCredential(db, "firebase-user"), undefined);
});
