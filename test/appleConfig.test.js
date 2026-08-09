import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  createAppleRuntime,
  getAppleConfigurationSummary,
} from "../src/subscriptions/appleConfig.js";

function validEnvironment() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    NODE_ENV: "development",
    APPLE_ALLOWED_ENVIRONMENTS: "Sandbox",
    APPLE_BUNDLE_ID: "com.chilltech.pantrio",
    APPLE_IAP_KEY_ID: "KEY123",
    APPLE_IAP_ISSUER_ID: "issuer-id",
    APPLE_IAP_PRIVATE_KEY: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    APPLE_ROOT_CERTIFICATES_BASE64_JSON: JSON.stringify([
      Buffer.from("test-certificate").toString("base64"),
    ]),
  };
}

test("constructs a configured Sandbox runtime with injected Apple clients", () => {
  const verifierCalls = [];
  const apiCalls = [];
  class FakeVerifier {
    constructor(...args) {
      verifierCalls.push(args);
    }
  }
  class FakeApiClient {
    constructor(...args) {
      apiCalls.push(args);
    }
  }

  const runtime = createAppleRuntime({
    env: validEnvironment(),
    Verifier: FakeVerifier,
    ApiClient: FakeApiClient,
  });

  assert.equal(runtime.enabled, true);
  assert.deepEqual(runtime.environments, ["Sandbox"]);
  assert.equal(verifierCalls.length, 1);
  assert.equal(apiCalls.length, 1);
});

test("never allows Sandbox verification in production", () => {
  assert.throws(
    () =>
      getAppleConfigurationSummary({
        ...validEnvironment(),
        NODE_ENV: "production",
        APPLE_ALLOWED_ENVIRONMENTS: "Sandbox",
      }),
    /Production may only accept/
  );
});

test("rejects a malformed App Store API signing key before enabling purchases", () => {
  assert.throws(
    () =>
      createAppleRuntime({
        env: {
          ...validEnvironment(),
          APPLE_IAP_PRIVATE_KEY: "not-a-private-key",
        },
        Verifier: class {},
        ApiClient: class {},
      }),
    /not a valid private key/
  );
});

