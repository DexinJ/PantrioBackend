import { createPrivateKey } from "node:crypto";

import fetch from "node-fetch";

const REQUIRED_ENVIRONMENT_KEYS = [
  "APPLE_SIGN_IN_CLIENT_ID",
  "APPLE_SIGN_IN_TEAM_ID",
  "APPLE_SIGN_IN_KEY_ID",
  "APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64",
];

let runtime = null;

function readPrivateKey(env) {
  if (String(env.APPLE_SIGN_IN_PRIVATE_KEY_BASE64 || "").trim()) {
    return Buffer.from(
      String(env.APPLE_SIGN_IN_PRIVATE_KEY_BASE64).trim(),
      "base64"
    ).toString("utf8");
  }

  return String(env.APPLE_SIGN_IN_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function readEncryptionKey(env) {
  const encoded = String(
    env.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64 || ""
  ).trim();
  const key = Buffer.from(encoded, "base64");

  if (!encoded || key.length !== 32) {
    throw new Error(
      "APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes"
    );
  }

  return key;
}

export function getAppleSignInConfigurationSummary(env = process.env) {
  const missing = REQUIRED_ENVIRONMENT_KEYS.filter(
    (key) => !String(env[key] || "").trim()
  );

  if (!readPrivateKey(env).trim()) {
    missing.push(
      "APPLE_SIGN_IN_PRIVATE_KEY or APPLE_SIGN_IN_PRIVATE_KEY_BASE64"
    );
  }

  return {
    enabled: missing.length === 0,
    missing,
    clientId: String(env.APPLE_SIGN_IN_CLIENT_ID || "").trim(),
  };
}

export function createAppleSignInRuntime({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const summary = getAppleSignInConfigurationSummary(env);
  if (!summary.enabled) {
    const error = new Error(
      `Sign in with Apple revocation is not configured: ${summary.missing.join(
        ", "
      )}`
    );
    error.code = "APPLE_SIGN_IN_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(readPrivateKey(env));
  } catch (cause) {
    throw new Error(
      `APPLE_SIGN_IN_PRIVATE_KEY is not a valid private key: ${cause.message}`,
      { cause }
    );
  }

  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("APPLE_SIGN_IN_PRIVATE_KEY must be an EC P-256 key");
  }

  return {
    clientId: summary.clientId,
    teamId: String(env.APPLE_SIGN_IN_TEAM_ID).trim(),
    keyId: String(env.APPLE_SIGN_IN_KEY_ID).trim(),
    privateKey,
    encryptionKey: readEncryptionKey(env),
    encryptionKeyId: String(
      env.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_ID || "v1"
    ).trim(),
    fetchImpl,
    jwksCache: null,
    jwksPromise: null,
  };
}

export function getAppleSignInRuntime() {
  if (!runtime) runtime = createAppleSignInRuntime();
  return runtime;
}

export function initializeAppleSignIn(env = process.env) {
  runtime = null;
  const summary = getAppleSignInConfigurationSummary(env);
  if (!summary.enabled) return summary;

  try {
    runtime = createAppleSignInRuntime({ env });
    return summary;
  } catch (error) {
    // A malformed optional Apple credential must not prevent the API from
    // starting. Linking stays disabled and account deletion records the
    // durable manual-required fallback when it attempts revocation.
    return {
      ...summary,
      enabled: false,
      invalid: true,
      errorCode: String(
        error?.code || "APPLE_SIGN_IN_CONFIGURATION_INVALID"
      ),
    };
  }
}

export function resetAppleSignInRuntimeForTests() {
  runtime = null;
}
