import fs from "node:fs";
import { createPrivateKey } from "node:crypto";

import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

import { getPublicAppleProducts } from "./planCatalog.js";

const SUPPORTED_ENVIRONMENTS = new Set([
  Environment.PRODUCTION,
  Environment.SANDBOX,
]);

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function allowSandboxInProduction(env) {
  return /^true$/i.test(
    String(env.APPLE_ALLOW_SANDBOX_IN_PRODUCTION || "").trim()
  );
}

function allowedEnvironments(env) {
  const fallback =
    env.NODE_ENV === "production"
      ? [Environment.PRODUCTION]
      : [Environment.SANDBOX];
  const values = splitCsv(env.APPLE_ALLOWED_ENVIRONMENTS);
  const configured = values.length ? values : fallback;
  for (const value of configured) {
    if (!SUPPORTED_ENVIRONMENTS.has(value)) {
      throw new Error(
        `APPLE_ALLOWED_ENVIRONMENTS contains unsupported value: ${value}`
      );
    }
  }
  if (env.NODE_ENV === "production") {
    if (allowSandboxInProduction(env)) {
      return [Environment.PRODUCTION, Environment.SANDBOX];
    }
    if (configured.some((value) => value !== Environment.PRODUCTION)) {
      throw new Error(
        "Production may only accept the Apple Production environment unless " +
          "APPLE_ALLOW_SANDBOX_IN_PRODUCTION=true"
      );
    }
  }
  return [...new Set(configured)];
}

function loadRootCertificates(env, readFileSync) {
  const certificates = [];
  const base64Json = String(
    env.APPLE_ROOT_CERTIFICATES_BASE64_JSON || ""
  ).trim();

  if (base64Json) {
    let values;
    try {
      values = JSON.parse(base64Json);
    } catch (error) {
      throw new Error(
        `APPLE_ROOT_CERTIFICATES_BASE64_JSON must be a JSON array: ${error.message}`
      );
    }
    if (!Array.isArray(values)) {
      throw new Error("APPLE_ROOT_CERTIFICATES_BASE64_JSON must be a JSON array");
    }
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error("Apple root certificate entries must be base64 strings");
      }
      certificates.push(Buffer.from(value.trim(), "base64"));
    }
  }

  for (const certificatePath of splitCsv(env.APPLE_ROOT_CERTIFICATE_PATHS)) {
    certificates.push(readFileSync(certificatePath));
  }

  return certificates;
}

function loadPrivateKey(env) {
  if (env.APPLE_IAP_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.APPLE_IAP_PRIVATE_KEY_BASE64, "base64").toString(
      "utf8"
    );
  }
  return String(env.APPLE_IAP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

export function getAppleConfigurationSummary(env = process.env) {
  const environments = allowedEnvironments(env);
  const appId = Number(env.APPLE_APP_ID);
  const missing = [];
  if (!String(env.APPLE_BUNDLE_ID || "").trim()) missing.push("APPLE_BUNDLE_ID");
  if (!String(env.APPLE_IAP_KEY_ID || "").trim()) missing.push("APPLE_IAP_KEY_ID");
  if (!String(env.APPLE_IAP_ISSUER_ID || "").trim()) {
    missing.push("APPLE_IAP_ISSUER_ID");
  }
  if (!loadPrivateKey(env).trim()) {
    missing.push("APPLE_IAP_PRIVATE_KEY or APPLE_IAP_PRIVATE_KEY_BASE64");
  }
  let hasInlineCertificate = false;
  const inlineCertificates = String(
    env.APPLE_ROOT_CERTIFICATES_BASE64_JSON || ""
  ).trim();
  if (inlineCertificates) {
    let values;
    try {
      values = JSON.parse(inlineCertificates);
    } catch (error) {
      throw new Error(
        `APPLE_ROOT_CERTIFICATES_BASE64_JSON must be a JSON array: ${error.message}`
      );
    }
    if (!Array.isArray(values)) {
      throw new Error("APPLE_ROOT_CERTIFICATES_BASE64_JSON must be a JSON array");
    }
    if (
      values.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new Error("Apple root certificate entries must be base64 strings");
    }
    hasInlineCertificate = values.length > 0;
  }
  if (
    !hasInlineCertificate &&
    splitCsv(env.APPLE_ROOT_CERTIFICATE_PATHS).length === 0
  ) {
    missing.push(
      "APPLE_ROOT_CERTIFICATES_BASE64_JSON or APPLE_ROOT_CERTIFICATE_PATHS"
    );
  }
  if (
    environments.includes(Environment.PRODUCTION) &&
    (!Number.isSafeInteger(appId) || appId <= 0)
  ) {
    missing.push("APPLE_APP_ID");
  }

  return {
    enabled: missing.length === 0,
    environments,
    missing,
  };
}

export function createAppleRuntime({
  env = process.env,
  readFileSync = fs.readFileSync,
  Verifier = SignedDataVerifier,
  ApiClient = AppStoreServerAPIClient,
} = {}) {
  const summary = getAppleConfigurationSummary(env);
  if (!summary.enabled) {
    const error = new Error(
      `Apple subscriptions are not configured: ${summary.missing.join(", ")}`
    );
    error.code = "APPLE_NOT_CONFIGURED";
    throw error;
  }

  const bundleId = String(env.APPLE_BUNDLE_ID).trim();
  const appId = Number(env.APPLE_APP_ID);
  const keyId = String(env.APPLE_IAP_KEY_ID).trim();
  const issuerId = String(env.APPLE_IAP_ISSUER_ID).trim();
  const privateKey = loadPrivateKey(env);
  let parsedPrivateKey;
  try {
    parsedPrivateKey = createPrivateKey(privateKey);
  } catch (error) {
    throw new Error(`APPLE_IAP_PRIVATE_KEY is not a valid private key: ${error.message}`);
  }
  if (
    parsedPrivateKey.asymmetricKeyType !== "ec" ||
    parsedPrivateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("APPLE_IAP_PRIVATE_KEY must be an EC P-256 private key");
  }
  const rootCertificates = loadRootCertificates(env, readFileSync);
  if (rootCertificates.length === 0 || rootCertificates.some((value) => !value.length)) {
    throw new Error("At least one non-empty Apple root certificate is required");
  }

  const onlineChecks = !/^(0|false|no)$/i.test(
    String(env.APPLE_ENABLE_ONLINE_CHECKS ?? "true")
  );
  const verifiers = new Map();
  const apiClients = new Map();
  for (const environment of summary.environments) {
    verifiers.set(
      environment,
      new Verifier(
        rootCertificates,
        onlineChecks,
        environment,
        bundleId,
        environment === Environment.PRODUCTION ? appId : undefined
      )
    );
    apiClients.set(
      environment,
      new ApiClient(privateKey, keyId, issuerId, bundleId, environment)
    );
  }

  return Object.freeze({
    enabled: true,
    bundleId,
    appId: Number.isSafeInteger(appId) ? appId : null,
    environments: Object.freeze(summary.environments),
    verifiers,
    apiClients,
  });
}

let runtime;
export function getAppleRuntime() {
  if (!runtime) runtime = createAppleRuntime();
  return runtime;
}

export function getAppleSessionConfiguration(env = process.env) {
  const summary = getAppleConfigurationSummary(env);
  if (summary.enabled) getAppleRuntime();
  return {
    enabled: summary.enabled,
    products: getPublicAppleProducts(),
  };
}

export function initializeAppleSubscriptions(env = process.env) {
  const summary = getAppleConfigurationSummary(env);
  if (summary.enabled) getAppleRuntime();
  return summary;
}

export function isAppleEnvironmentAllowed(environment, env = process.env) {
  return allowedEnvironments(env).includes(environment);
}
