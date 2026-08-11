import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import jwt from "jsonwebtoken";

import {
  createAppleSignInRuntime,
  getAppleSignInConfigurationSummary,
  initializeAppleSignIn,
  resetAppleSignInRuntimeForTests,
} from "../src/auth/appleSignInConfig.js";
import { createAppleClientSecret } from "../src/auth/appleSignInService.js";

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

test("keeps Sign in with Apple revocation disabled when configuration is absent", () => {
  const summary = getAppleSignInConfigurationSummary({});
  assert.equal(summary.enabled, false);
  assert.ok(summary.missing.includes("APPLE_SIGN_IN_CLIENT_ID"));
});

test("creates a short-lived Apple client-secret JWT with the required claims", () => {
  const runtime = createAppleSignInRuntime({
    env: validEnvironment(),
    fetchImpl: async () => {
      throw new Error("not called");
    },
  });
  const token = createAppleClientSecret(runtime, { nowSeconds: 1_700_000_000 });
  const decoded = jwt.decode(token, { complete: true });

  assert.equal(decoded.header.alg, "ES256");
  assert.equal(decoded.header.kid, "KEY1234567");
  assert.deepEqual(
    {
      iss: decoded.payload.iss,
      iat: decoded.payload.iat,
      exp: decoded.payload.exp,
      aud: decoded.payload.aud,
      sub: decoded.payload.sub,
    },
    {
      iss: "TEAM123456",
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      aud: "https://appleid.apple.com",
      sub: "com.chilltech.pantrio",
    }
  );
});

test("rejects encryption keys that are not exactly 32 bytes", () => {
  assert.throws(
    () =>
      createAppleSignInRuntime({
        env: {
          ...validEnvironment(),
          APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64:
            randomBytes(31).toString("base64"),
        },
      }),
    /exactly 32 bytes/
  );
});

test("does not accept an App Store-style RSA key for Sign in with Apple", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      createAppleSignInRuntime({
        env: {
          ...validEnvironment(),
          APPLE_SIGN_IN_PRIVATE_KEY: privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
        },
      }),
    /EC P-256/
  );
});

test("malformed optional Apple configuration does not block server initialization", (t) => {
  t.after(() => resetAppleSignInRuntimeForTests());
  const summary = initializeAppleSignIn({
    ...validEnvironment(),
    APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64:
      randomBytes(31).toString("base64"),
  });

  assert.equal(summary.enabled, false);
  assert.equal(summary.invalid, true);
  assert.equal(
    summary.errorCode,
    "APPLE_SIGN_IN_CONFIGURATION_INVALID"
  );
});
