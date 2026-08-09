import {
  Environment,
  InAppOwnershipType,
  Status,
  Type,
  VerificationStatus,
} from "@apple/app-store-server-library";

import { getAppleRuntime } from "./appleConfig.js";
import {
  findUserByAppleAccountToken,
  getAppleSubscriptionRefreshTarget,
  hasProcessedAppleNotification,
  recordProcessedAppleNotification,
  saveVerifiedAppleState,
} from "./appleSubscriptionStore.js";
import { getPlanByProductId } from "./planCatalog.js";

const VERIFY_SOURCES = new Set([
  "purchase",
  "restore",
  "refresh",
  "transaction_update",
]);
const MAX_EVIDENCE_ITEMS = 20;
const MAX_STATUS_CHAINS = 10;
const MAX_JWS_LENGTH = 64 * 1024;
const VALID_STATUSES = new Set(Object.values(Status).filter(Number.isInteger));

export class AppleSubscriptionError extends Error {
  constructor(code, message, { status = 400, cause, details } = {}) {
    super(message, { cause });
    this.name = "AppleSubscriptionError";
    this.code = code;
    this.status = status;
    this.details = details || null;
  }
}

function fail(code, message, status = 400, cause) {
  throw new AppleSubscriptionError(code, message, { status, cause });
}

function normalizeJws(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_APPLE_EVIDENCE", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_JWS_LENGTH) {
    fail("INVALID_APPLE_EVIDENCE", `${field} is too large`, 413);
  }
  return normalized;
}

function normalizeAppleVerificationEnvelope(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("INVALID_APPLE_EVIDENCE", "Request body must be an object");
  }
  if (!VERIFY_SOURCES.has(body.source)) {
    fail(
      "INVALID_APPLE_EVIDENCE",
      "source must be purchase, restore, refresh, or transaction_update"
    );
  }
  if (
    !Array.isArray(body.evidence) ||
    body.evidence.length === 0 ||
    body.evidence.length > MAX_EVIDENCE_ITEMS
  ) {
    fail(
      "INVALID_APPLE_EVIDENCE",
      `evidence must contain 1-${MAX_EVIDENCE_ITEMS} items`
    );
  }

  return { source: body.source, evidence: body.evidence };
}

function normalizeAppleEvidenceItem(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail("INVALID_APPLE_EVIDENCE", `evidence[${index}] must be an object`);
  }
  return {
    signedTransactionInfo: normalizeJws(
      item.signedTransactionInfo,
      `evidence[${index}].signedTransactionInfo`
    ),
    signedRenewalInfo: normalizeJws(
      item.signedRenewalInfo,
      `evidence[${index}].signedRenewalInfo`,
      { optional: true }
    ),
  };
}

export function normalizeAppleVerificationRequest(body) {
  const envelope = normalizeAppleVerificationEnvelope(body);
  return {
    source: envelope.source,
    evidence: envelope.evidence.map(normalizeAppleEvidenceItem),
  };
}

async function verifyInAnyEnvironment(runtime, method, signedData) {
  let lastError;
  let retryableError;
  for (const environment of runtime.environments) {
    const verifier = runtime.verifiers.get(environment);
    try {
      const decoded = await verifier[method](signedData);
      return { environment, decoded, verifier };
    } catch (error) {
      lastError = error;
      if (error?.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
        retryableError ||= error;
      }
    }
  }
  if (retryableError) {
    fail(
      "APPLE_VERIFICATION_UNAVAILABLE",
      "Apple signature verification is temporarily unavailable.",
      503,
      retryableError
    );
  }
  fail(
    "APPLE_VERIFICATION_FAILED",
    "Apple could not verify the signed subscription data.",
    422,
    lastError
  );
}

function requireTransactionFields(transaction, environment) {
  const requiredStrings = [
    "transactionId",
    "originalTransactionId",
    "productId",
    "appAccountToken",
  ];
  for (const field of requiredStrings) {
    if (typeof transaction?.[field] !== "string" || !transaction[field].trim()) {
      fail(
        "INVALID_APPLE_TRANSACTION",
        `Verified Apple transaction is missing ${field}.`,
        422
      );
    }
  }
  if (transaction.environment !== environment) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "Apple transaction environment does not match its signature.",
      422
    );
  }
  if (transaction.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "The verified Apple transaction is not an auto-renewable subscription.",
      422
    );
  }
  if (transaction.inAppOwnershipType !== InAppOwnershipType.PURCHASED) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "Family-shared transactions cannot be linked to an app account.",
      422
    );
  }
  if (
    !Number.isFinite(transaction.expiresDate) ||
    transaction.expiresDate <= 0 ||
    !Number.isFinite(transaction.signedDate) ||
    transaction.signedDate <= 0
  ) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "Verified Apple transaction is missing subscription timestamps.",
      422
    );
  }
  const plan = getPlanByProductId(transaction.productId);
  if (!plan) {
    fail(
      "APPLE_PRODUCT_NOT_CONFIGURED",
      "This App Store product is not configured on the server.",
      422
    );
  }
  return plan;
}

function requireMatchingAccountToken(transaction, expectedToken) {
  if (
    transaction.appAccountToken.toLowerCase() !==
    String(expectedToken || "").toLowerCase()
  ) {
    fail(
      "APPLE_PURCHASE_ACCOUNT_MISMATCH",
      "This purchase was not created for the signed-in account.",
      409
    );
  }
}

async function decodeRenewal(verifier, signedRenewalInfo, transaction) {
  if (!signedRenewalInfo) return null;
  let renewal;
  try {
    renewal = await verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);
  } catch (error) {
    fail(
      "APPLE_VERIFICATION_FAILED",
      "Apple could not verify the signed renewal data.",
      422,
      error
    );
  }
  if (
    renewal.originalTransactionId &&
    renewal.originalTransactionId !== transaction.originalTransactionId
  ) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "The renewal and transaction identifiers do not match.",
      422
    );
  }
  if (
    renewal.appAccountToken &&
    renewal.appAccountToken.toLowerCase() !==
      transaction.appAccountToken.toLowerCase()
  ) {
    fail(
      "INVALID_APPLE_TRANSACTION",
      "The renewal and transaction account tokens do not match.",
      422
    );
  }
  return renewal;
}

function validStatus(value) {
  return VALID_STATUSES.has(value) ? value : null;
}

function recordFromApple({
  uid,
  environment,
  status,
  transaction,
  renewal,
  observedSignedDate,
}) {
  const plan = requireTransactionFields(transaction, environment);
  return {
    uid,
    environment,
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    appAccountToken: transaction.appAccountToken,
    productId: transaction.productId,
    planId: plan.id,
    status:
      validStatus(status) ||
      (transaction.revocationDate
        ? Status.REVOKED
        : transaction.expiresDate > Date.now()
          ? Status.ACTIVE
          : Status.EXPIRED),
    purchaseDate: Number.isFinite(transaction.purchaseDate)
      ? transaction.purchaseDate
      : null,
    expiresAt: Number.isFinite(transaction.expiresDate)
      ? transaction.expiresDate
      : null,
    graceExpiresAt: Number.isFinite(renewal?.gracePeriodExpiresDate)
      ? renewal.gracePeriodExpiresDate
      : null,
    autoRenewStatus: Number.isInteger(renewal?.autoRenewStatus)
      ? renewal.autoRenewStatus
      : null,
    revokedAt: Number.isFinite(transaction.revocationDate)
      ? transaction.revocationDate
      : null,
    signedDate: Math.max(
      Number.isFinite(transaction.signedDate) ? transaction.signedDate : 0,
      Number.isFinite(renewal?.signedDate) ? renewal.signedDate : 0,
      Number.isFinite(observedSignedDate) ? observedSignedDate : 0
    ),
  };
}

async function fetchAndPersistCurrentStatus(
  db,
  {
    uid,
    appAccountToken,
    environment,
    transactionId,
    originalTransactionId,
    runtime,
  }
) {
  const apiClient = runtime.apiClients.get(environment);
  if (!apiClient) {
    fail(
      "APPLE_ENVIRONMENT_NOT_CONFIGURED",
      "The App Store environment is not configured on this server.",
      503
    );
  }

  let response;
  try {
    response = await apiClient.getAllSubscriptionStatuses(transactionId);
  } catch (error) {
    fail(
      "APPLE_STATUS_UNAVAILABLE",
      "Apple subscription status is temporarily unavailable.",
      502,
      error
    );
  }
  if (
    (response?.environment && response.environment !== environment) ||
    (response?.bundleId && response.bundleId !== runtime.bundleId)
  ) {
    fail(
      "APPLE_STATUS_INVALID",
      "Apple returned status for a different app or environment.",
      502
    );
  }

  const verifier = runtime.verifiers.get(environment);
  let saved = 0;
  let matchedRequestedChain = false;
  for (const group of response?.data || []) {
    for (const item of group?.lastTransactions || []) {
      if (!item?.signedTransactionInfo) continue;
      let transaction;
      let renewal = null;
      try {
        transaction = await verifier.verifyAndDecodeTransaction(
          item.signedTransactionInfo
        );
      } catch (error) {
        if (error instanceof AppleSubscriptionError) throw error;
        fail(
          "APPLE_VERIFICATION_FAILED",
          "Apple returned subscription status that could not be verified.",
          502,
          error
        );
      }

      requireTransactionFields(transaction, environment);
      if (
        transaction.appAccountToken.toLowerCase() !==
        appAccountToken.toLowerCase()
      ) {
        continue;
      }
      if (transaction.originalTransactionId !== originalTransactionId) {
        continue;
      }
      renewal = await decodeRenewal(
        verifier,
        item.signedRenewalInfo,
        transaction
      );
      await saveVerifiedAppleState(
        db,
        recordFromApple({
          uid,
          environment,
          status: item.status,
          transaction,
          renewal,
        })
      );
      saved += 1;
      if (transaction.originalTransactionId === originalTransactionId) {
        matchedRequestedChain = true;
      }
    }
  }

  if (saved === 0 || !matchedRequestedChain) {
    fail(
      "APPLE_STATUS_NOT_FOUND",
      "Apple did not return a subscription for this app account.",
      422
    );
  }
}

function asAppleSubscriptionError(error) {
  if (error instanceof AppleSubscriptionError) return error;
  if (error?.code === "APPLE_PURCHASE_ACCOUNT_CONFLICT") {
    return new AppleSubscriptionError(
      error.code,
      "This App Store subscription is already linked to another account.",
      { status: 409, cause: error }
    );
  }
  return new AppleSubscriptionError(
    "APPLE_SUBSCRIPTION_ERROR",
    "Apple subscription verification failed.",
    { status: 500, cause: error }
  );
}

function rejectedEvidence(index, error) {
  const normalizedError = asAppleSubscriptionError(error);
  return {
    error: normalizedError,
    public: {
      index,
      code: normalizedError.code,
      retryable:
        normalizedError.status === 429 || normalizedError.status >= 500,
    },
  };
}

function throwAllEvidenceRejected(failures) {
  const preferred =
    failures.find(({ error }) => error.status >= 500) ||
    failures.find(({ error }) => error.status === 409) ||
    failures[0];
  const rejected = failures
    .map((failure) => failure.public)
    .sort((left, right) => left.index - right.index);
  throw new AppleSubscriptionError(
    preferred?.error?.code || "APPLE_VERIFICATION_FAILED",
    preferred?.error?.message || "No Apple subscription evidence was accepted.",
    {
      status: preferred?.error?.status || 422,
      cause: preferred?.error,
      details: { rejected, rejectedCount: rejected.length },
    }
  );
}

export async function verifyAppleEvidenceForUser(
  db,
  { uid, appAccountToken, body, runtime = getAppleRuntime() }
) {
  if (!uid || !appAccountToken) {
    fail(
      "APPLE_ACCOUNT_NOT_READY",
      "The signed-in account does not have an Apple account token.",
      409
    );
  }
  const request = normalizeAppleVerificationEnvelope(body);
  const verified = [];
  const failures = [];

  for (let index = 0; index < request.evidence.length; index += 1) {
    try {
      const item = normalizeAppleEvidenceItem(request.evidence[index], index);
      const result = await verifyInAnyEnvironment(
        runtime,
        "verifyAndDecodeTransaction",
        item.signedTransactionInfo
      );
      requireTransactionFields(result.decoded, result.environment);
      requireMatchingAccountToken(result.decoded, appAccountToken);
      const renewal = await decodeRenewal(
        result.verifier,
        item.signedRenewalInfo,
        result.decoded
      );
      verified.push({
        index,
        environment: result.environment,
        transaction: result.decoded,
        renewal,
      });
    } catch (error) {
      failures.push(rejectedEvidence(index, error));
    }
  }

  const uniqueChains = new Map();
  for (const item of verified) {
    const key = `${item.environment}:${item.transaction.originalTransactionId}`;
    const existing = uniqueChains.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    if (uniqueChains.size >= MAX_STATUS_CHAINS) {
      failures.push(
        rejectedEvidence(
          item.index,
          new AppleSubscriptionError(
            "TOO_MANY_APPLE_SUBSCRIPTION_CHAINS",
            `Evidence may reference at most ${MAX_STATUS_CHAINS} subscription chains.`,
            { status: 413 }
          )
        )
      );
      continue;
    }
    uniqueChains.set(key, { representative: item, items: [item] });
  }

  const acceptedTransactionIds = new Set();
  for (const chain of uniqueChains.values()) {
    const item = chain.representative;
    try {
      await fetchAndPersistCurrentStatus(db, {
        uid,
        appAccountToken,
        environment: item.environment,
        transactionId: item.transaction.transactionId,
        originalTransactionId: item.transaction.originalTransactionId,
        runtime,
      });
      for (const accepted of chain.items) {
        acceptedTransactionIds.add(accepted.transaction.transactionId);
      }
    } catch (error) {
      for (const rejected of chain.items) {
        failures.push(rejectedEvidence(rejected.index, error));
      }
    }
  }

  if (acceptedTransactionIds.size === 0) throwAllEvidenceRejected(failures);

  const rejected = failures
    .map((failure) => failure.public)
    .sort((left, right) => left.index - right.index);

  return {
    source: request.source,
    acceptedTransactionIds: [...acceptedTransactionIds],
    rejected,
    rejectedCount: rejected.length,
  };
}

export async function refreshAppleSubscriptionForUser(
  db,
  { uid, appAccountToken, runtime = getAppleRuntime() }
) {
  const target = await getAppleSubscriptionRefreshTarget(db, uid);
  if (!target) return { refreshed: false };
  await fetchAndPersistCurrentStatus(db, {
    uid,
    appAccountToken,
    environment: target.environment,
    transactionId: target.latest_transaction_id,
    originalTransactionId: target.original_transaction_id,
    runtime,
  });
  return { refreshed: true };
}

function statusFromNotification(notification, transaction) {
  const explicit = validStatus(notification?.data?.status);
  if (explicit) return explicit;
  if (transaction.revocationDate) return Status.REVOKED;
  switch (notification.notificationType) {
    case "REFUND":
    case "REVOKE":
      return Status.REVOKED;
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return Status.EXPIRED;
    case "DID_FAIL_TO_RENEW":
      return Status.BILLING_RETRY;
    default:
      return transaction.expiresDate > Date.now()
        ? Status.ACTIVE
        : Status.EXPIRED;
  }
}

export async function processAppleNotification(
  db,
  signedPayload,
  { runtime = getAppleRuntime() } = {}
) {
  const normalizedPayload = normalizeJws(signedPayload, "signedPayload");
  const result = await verifyInAnyEnvironment(
    runtime,
    "verifyAndDecodeNotification",
    normalizedPayload
  );
  const notification = result.decoded;
  const notificationUUID = notification.notificationUUID;
  if (typeof notificationUUID !== "string" || !notificationUUID) {
    fail(
      "INVALID_APPLE_NOTIFICATION",
      "Verified Apple notification has no notification UUID.",
      422
    );
  }
  if (
    await hasProcessedAppleNotification(
      db,
      result.environment,
      notificationUUID
    )
  ) {
    return { duplicate: true, notificationUUID };
  }

  let uid = null;
  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  if (signedTransactionInfo) {
    let transaction;
    let renewal = null;
    try {
      transaction = await result.verifier.verifyAndDecodeTransaction(
        signedTransactionInfo
      );
      renewal = await decodeRenewal(
        result.verifier,
        notification.data?.signedRenewalInfo,
        transaction
      );
    } catch (error) {
      if (error instanceof AppleSubscriptionError) throw error;
      fail(
        "APPLE_VERIFICATION_FAILED",
        "Apple notification transaction could not be verified.",
        422,
        error
      );
    }
    requireTransactionFields(transaction, result.environment);
    const user = await findUserByAppleAccountToken(
      db,
      transaction.appAccountToken
    );
    if (user) {
      uid = user.uid;
      await saveVerifiedAppleState(
        db,
        recordFromApple({
          uid,
          environment: result.environment,
          status: statusFromNotification(notification, transaction),
          transaction,
          renewal,
          observedSignedDate: notification.signedDate,
        })
      );
    }
  }

  await recordProcessedAppleNotification(db, {
    environment: result.environment,
    notificationUUID,
    notificationType: notification.notificationType,
    subtype: notification.subtype,
    uid,
    signedDate: notification.signedDate,
  });
  return { duplicate: false, notificationUUID, matchedUser: Boolean(uid) };
}

export { Environment };
