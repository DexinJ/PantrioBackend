import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  randomBytes,
} from "node:crypto";

import jwt from "jsonwebtoken";

import { getFirebaseUser } from "./firebase.js";
import { getAppleSignInRuntime } from "./appleSignInConfig.js";
import {
  AppleSignInCredentialConflictError,
  getAppleSignInCredential,
  saveAppleSignInCredential,
} from "./appleSignInStore.js";

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_REQUEST_TIMEOUT_MS = 10_000;
const APPLE_JWKS_CACHE_MS = 60 * 60 * 1_000;
const RECENT_APPLE_AUTH_MAX_AGE_MS = 6 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;
const MAX_AUTHORIZATION_CODE_LENGTH = 8_192;
const SUPPORTED_APPLE_ID_TOKEN_ALGORITHMS = new Set(["RS256", "ES256"]);

export class AppleSignInError extends Error {
  constructor(
    code,
    message,
    { status = 400, retryable = false, cause } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppleSignInError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function fail(code, message, options) {
  throw new AppleSignInError(code, message, options);
}

function normalizeAuthorizationCode(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail(
      "APPLE_AUTHORIZATION_CODE_REQUIRED",
      "authorizationCode must be a non-empty string"
    );
  }

  const code = value.trim();
  if (code.length > MAX_AUTHORIZATION_CODE_LENGTH) {
    fail(
      "APPLE_AUTHORIZATION_CODE_INVALID",
      "authorizationCode is too large",
      { status: 413 }
    );
  }

  return code;
}

export function assertRecentAppleAuthentication(
  decoded,
  { nowMs = Date.now() } = {}
) {
  if (decoded?.firebase?.sign_in_provider !== "apple.com") {
    fail(
      "APPLE_RECENT_AUTH_REQUIRED",
      "A recent Sign in with Apple authentication is required.",
      { status: 403 }
    );
  }

  const authTimeMs = Number(decoded?.auth_time) * 1_000;
  if (
    !Number.isFinite(authTimeMs) ||
    authTimeMs > nowMs + CLOCK_SKEW_MS ||
    nowMs - authTimeMs > RECENT_APPLE_AUTH_MAX_AGE_MS
  ) {
    fail(
      "APPLE_RECENT_AUTH_REQUIRED",
      "A recent Sign in with Apple authentication is required.",
      { status: 403 }
    );
  }
}

export function createAppleClientSecret(
  runtime,
  { nowSeconds = Math.floor(Date.now() / 1_000) } = {}
) {
  return jwt.sign(
    {
      iss: runtime.teamId,
      iat: nowSeconds,
      exp: nowSeconds + 5 * 60,
      aud: APPLE_ISSUER,
      sub: runtime.clientId,
    },
    runtime.privateKey,
    {
      algorithm: "ES256",
      keyid: runtime.keyId,
      header: { typ: "JWT" },
    }
  );
}

function credentialAad({ uid, clientId, appleSubject }) {
  return Buffer.from(
    JSON.stringify([1, String(uid), String(clientId), String(appleSubject)]),
    "utf8"
  );
}

export function encryptAppleRefreshToken(
  refreshToken,
  binding,
  runtime = getAppleSignInRuntime()
) {
  if (typeof refreshToken !== "string" || !refreshToken) {
    fail("APPLE_TOKEN_RESPONSE_INVALID", "Apple returned an invalid token.", {
      status: 502,
    });
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", runtime.encryptionKey, iv);
  cipher.setAAD(credentialAad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(refreshToken, "utf8"),
    cipher.final(),
  ]);

  return JSON.stringify({
    v: 1,
    kid: runtime.encryptionKeyId,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

export function decryptAppleRefreshToken(
  envelope,
  binding,
  runtime = getAppleSignInRuntime()
) {
  try {
    const parsed = JSON.parse(String(envelope || ""));
    if (
      parsed?.v !== 1 ||
      parsed?.kid !== runtime.encryptionKeyId ||
      typeof parsed?.iv !== "string" ||
      typeof parsed?.tag !== "string" ||
      typeof parsed?.ciphertext !== "string"
    ) {
      throw new Error("Unsupported encrypted token envelope");
    }

    const iv = Buffer.from(parsed.iv, "base64url");
    const tag = Buffer.from(parsed.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("Invalid encrypted token envelope");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      runtime.encryptionKey,
      iv
    );
    decipher.setAAD(credentialAad(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new AppleSignInError(
      "APPLE_STORED_CREDENTIAL_INVALID",
      "The stored Apple credential could not be read.",
      { status: 500, cause }
    );
  }
}

async function requestApple(runtime, url, { method = "GET", form } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    APPLE_REQUEST_TIMEOUT_MS
  );
  let response;
  let text;

  try {
    response = await runtime.fetchImpl(url, {
      method,
      headers: form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : undefined,
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (cause) {
    throw new AppleSignInError(
      "APPLE_SERVICE_UNAVAILABLE",
      "Apple authentication services are temporarily unavailable.",
      { status: 503, retryable: true, cause }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const appleCode =
      typeof payload?.error === "string" ? payload.error : "unknown_error";
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    throw new AppleSignInError(
      "APPLE_REQUEST_FAILED",
      `Apple rejected the authentication request (${appleCode}).`,
      {
        status: retryable ? 503 : 502,
        retryable,
      }
    );
  }

  return { payload, response };
}

export async function exchangeAppleAuthorizationCode(runtime, code) {
  const clientSecret = createAppleClientSecret(runtime);
  const { payload } = await requestApple(runtime, APPLE_TOKEN_URL, {
    method: "POST",
    form: {
      client_id: runtime.clientId,
      client_secret: clientSecret,
      code: normalizeAuthorizationCode(code),
      grant_type: "authorization_code",
    },
  });

  if (
    typeof payload?.refresh_token !== "string" ||
    !payload.refresh_token ||
    typeof payload?.id_token !== "string" ||
    !payload.id_token
  ) {
    fail(
      "APPLE_TOKEN_RESPONSE_INVALID",
      "Apple returned an incomplete token response.",
      { status: 502 }
    );
  }

  return payload;
}

async function loadAppleJwks(runtime, { force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    runtime.jwksCache?.expiresAt > now &&
    Array.isArray(runtime.jwksCache.keys)
  ) {
    return runtime.jwksCache.keys;
  }

  if (runtime.jwksPromise) return runtime.jwksPromise;

  const request = (async () => {
    const { payload } = await requestApple(runtime, APPLE_JWKS_URL);
    if (!Array.isArray(payload?.keys)) {
      fail(
        "APPLE_JWKS_INVALID",
        "Apple returned an invalid signing-key response.",
        { status: 502 }
      );
    }

    runtime.jwksCache = {
      keys: payload.keys,
      expiresAt: Date.now() + APPLE_JWKS_CACHE_MS,
    };
    return payload.keys;
  })();
  runtime.jwksPromise = request;
  try {
    return await request;
  } finally {
    if (runtime.jwksPromise === request) runtime.jwksPromise = null;
  }
}

export async function verifyAppleIdentityToken(runtime, identityToken) {
  const decoded = jwt.decode(identityToken, { complete: true });
  const algorithm = decoded?.header?.alg;
  const keyId = decoded?.header?.kid;
  if (
    typeof keyId !== "string" ||
    !SUPPORTED_APPLE_ID_TOKEN_ALGORITHMS.has(algorithm)
  ) {
    fail("APPLE_ID_TOKEN_INVALID", "Apple returned an invalid identity token.", {
      status: 502,
    });
  }

  let keys = await loadAppleJwks(runtime);
  let jwk = keys.find((candidate) => candidate?.kid === keyId);
  if (!jwk) {
    keys = await loadAppleJwks(runtime, { force: true });
    jwk = keys.find((candidate) => candidate?.kid === keyId);
  }
  if (!jwk || (jwk.alg && jwk.alg !== algorithm)) {
    fail("APPLE_ID_TOKEN_INVALID", "Apple returned an unknown identity token.", {
      status: 502,
    });
  }

  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const claims = jwt.verify(identityToken, publicKey, {
      algorithms: [algorithm],
      audience: runtime.clientId,
      issuer: APPLE_ISSUER,
      clockTolerance: CLOCK_SKEW_MS / 1_000,
    });
    if (!claims || typeof claims === "string" || !claims.sub) {
      throw new Error("Missing Apple subject");
    }
    return claims;
  } catch (cause) {
    throw new AppleSignInError(
      "APPLE_ID_TOKEN_INVALID",
      "Apple returned an invalid identity token.",
      { status: 502, cause }
    );
  }
}

export async function revokeAppleRefreshToken(runtime, refreshToken) {
  const clientSecret = createAppleClientSecret(runtime);
  await requestApple(runtime, APPLE_REVOKE_URL, {
    method: "POST",
    form: {
      client_id: runtime.clientId,
      client_secret: clientSecret,
      token: refreshToken,
      token_type_hint: "refresh_token",
    },
  });
}

export async function revokeAppleAuthorizationCredential(
  {
    uid,
    credential,
    runtime,
    revokeRefreshTokenFn = revokeAppleRefreshToken,
  }
) {
  if (!credential) return { status: "not_available" };

  const activeRuntime = runtime || getAppleSignInRuntime();
  if (credential.client_id !== activeRuntime.clientId) {
    fail(
      "APPLE_CLIENT_CONFIGURATION_MISMATCH",
      "The stored Apple credential does not match the configured client.",
      { status: 503 }
    );
  }

  const binding = {
    uid,
    clientId: credential.client_id,
    appleSubject: credential.apple_subject,
  };
  const refreshToken = decryptAppleRefreshToken(
    credential.encrypted_refresh_token,
    binding,
    activeRuntime
  );
  await revokeRefreshTokenFn(activeRuntime, refreshToken);
  return { status: "revoked" };
}

export async function linkAppleAuthorizationForUser(
  db,
  {
    decoded,
    authorizationCode,
    runtime = getAppleSignInRuntime(),
    getFirebaseUserFn = getFirebaseUser,
    exchangeAuthorizationCodeFn = exchangeAppleAuthorizationCode,
    verifyIdentityTokenFn = verifyAppleIdentityToken,
  }
) {
  assertRecentAppleAuthentication(decoded);
  const code = normalizeAuthorizationCode(authorizationCode);
  const firebaseUser = await getFirebaseUserFn(decoded.uid);
  const appleProvider = firebaseUser?.providerData?.find(
    (provider) => provider.providerId === "apple.com"
  );
  if (!appleProvider?.uid) {
    fail(
      "APPLE_PROVIDER_NOT_LINKED",
      "The Firebase account is not linked to Sign in with Apple.",
      { status: 403 }
    );
  }

  const tokenResponse = await exchangeAuthorizationCodeFn(runtime, code);
  const claims = await verifyIdentityTokenFn(runtime, tokenResponse.id_token);
  if (claims.sub !== appleProvider.uid) {
    fail(
      "APPLE_IDENTITY_MISMATCH",
      "The Apple authorization does not belong to this account.",
      { status: 403 }
    );
  }

  const binding = {
    uid: decoded.uid,
    clientId: runtime.clientId,
    appleSubject: claims.sub,
  };
  const encryptedRefreshToken = encryptAppleRefreshToken(
    tokenResponse.refresh_token,
    binding,
    runtime
  );
  try {
    await saveAppleSignInCredential(db, {
      ...binding,
      encryptedRefreshToken,
    });
  } catch (cause) {
    if (cause instanceof AppleSignInCredentialConflictError) {
      throw new AppleSignInError(cause.code, cause.message, {
        status: 409,
        cause,
      });
    }
    throw cause;
  }

  return { linked: true };
}

export async function revokeAppleAuthorizationForUser(
  db,
  {
    uid,
    runtime,
    revokeRefreshTokenFn = revokeAppleRefreshToken,
  }
) {
  const credential = await getAppleSignInCredential(db, uid);
  return revokeAppleAuthorizationCredential({
    uid,
    credential,
    runtime,
    revokeRefreshTokenFn,
  });
}

export function decodedTokenHasAppleIdentity(decoded) {
  const identities = decoded?.firebase?.identities?.["apple.com"];
  return (
    decoded?.firebase?.sign_in_provider === "apple.com" ||
    (Array.isArray(identities) && identities.length > 0)
  );
}

export function shouldUseManualAppleRevocationFallback(error) {
  return (
    error?.code === "APPLE_SIGN_IN_NOT_CONFIGURED" ||
    error instanceof AppleSignInError
  );
}
