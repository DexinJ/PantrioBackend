const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "subscribed",
  "in_grace_period",
]);

export const KNOWN_SUBSCRIPTION_STATUSES = Object.freeze([
  "subscribed",
  "in_grace_period",
  "in_billing_retry_period",
  "expired",
  "revoked",
  "unknown",
  "not_subscribed",
  "unsupported_platform",
  "development_build_required",
]);

const KNOWN_SUBSCRIPTION_STATUS_SET = new Set(KNOWN_SUBSCRIPTION_STATUSES);
export const SUBSCRIPTION_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SUBSCRIPTION_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const ISO_8601_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export class SubscriptionStatusValidationError extends TypeError {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = "SubscriptionStatusValidationError";
    this.code = "INVALID_SUBSCRIPTION_SNAPSHOT";
    this.field = field;
  }
}

function fail(field, message) {
  throw new SubscriptionStatusValidationError(field, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeRequiredStatus(snapshot) {
  if (!hasOwn(snapshot, "status")) {
    fail("status", "is required");
  }

  const { status } = snapshot;
  if (typeof status !== "string") {
    fail("status", "must be a string");
  }
  if (status === "loading") {
    fail("status", 'cannot be the transient value "loading"');
  }
  if (!KNOWN_SUBSCRIPTION_STATUS_SET.has(status)) {
    fail("status", "is not a recognized StoreKit subscription status");
  }

  return status;
}

function normalizeRequiredEntitlement(snapshot) {
  if (!hasOwn(snapshot, "isEntitled")) {
    fail("isEntitled", "is required");
  }
  if (typeof snapshot.isEntitled !== "boolean") {
    fail("isEntitled", "must be a boolean");
  }

  return snapshot.isEntitled;
}

function normalizeOptionalProductId(value, field = "productId") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    fail(field, "must be a string or null");
  }

  const normalized = value.trim();
  return normalized || null;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] || 0;
}

function isValidIso8601Timestamp(value) {
  const match = ISO_8601_DATE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

function normalizeOptionalIsoDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    fail(field, "must be an ISO-8601 string or null");
  }

  const normalized = value.trim();
  if (!isValidIso8601Timestamp(normalized)) {
    fail(field, "must be a valid ISO-8601 timestamp");
  }

  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) {
    fail(field, "must be a valid ISO-8601 timestamp");
  }

  return new Date(time).toISOString();
}

function normalizeOptionalBoolean(value, field) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    fail(field, "must be a boolean");
  }

  return value;
}

export function deriveIsSubscribed(
  status,
  isEntitled,
  {
    productId = null,
    expirationDate = null,
    checkedAt = null,
    isPartial = false,
    nowMs = Date.now(),
  } = {}
) {
  if (
    isEntitled !== true ||
    isPartial === true ||
    !ACTIVE_SUBSCRIPTION_STATUSES.has(status) ||
    !productId ||
    !expirationDate ||
    !checkedAt
  ) {
    return false;
  }

  const checkedAtMs = Date.parse(checkedAt);
  const expirationDateMs = Date.parse(expirationDate);

  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(expirationDateMs)) {
    return false;
  }

  if (
    checkedAtMs > nowMs + SUBSCRIPTION_CLOCK_SKEW_MS ||
    nowMs - checkedAtMs > SUBSCRIPTION_SNAPSHOT_MAX_AGE_MS
  ) {
    return false;
  }

  // A grace-period transaction may already have passed its normal expiration;
  // its fresh client-reported StoreKit status is used until the next sync.
  return status === "in_grace_period" || expirationDateMs > nowMs;
}

/**
 * Validate and copy only the client fields the backend persists. Extra StoreKit
 * transaction details are intentionally ignored rather than trusted or stored.
 */
export function normalizeSubscriptionSnapshot(
  snapshot,
  { nowMs = Date.now() } = {}
) {
  if (!isRecord(snapshot)) {
    fail("subscription", "must be an object");
  }

  const status = normalizeRequiredStatus(snapshot);
  const isEntitled = normalizeRequiredEntitlement(snapshot);
  const productId = normalizeOptionalProductId(snapshot.productId);
  const expirationDate = normalizeOptionalIsoDate(
    snapshot.expirationDate,
    "expirationDate"
  );
  const checkedAt = normalizeOptionalIsoDate(snapshot.checkedAt, "checkedAt");
  const isPartial = normalizeOptionalBoolean(
    snapshot.isPartial,
    "isPartial"
  );

  if (!checkedAt) {
    fail("checkedAt", "is required");
  }

  if (Date.parse(checkedAt) > nowMs + SUBSCRIPTION_CLOCK_SKEW_MS) {
    fail("checkedAt", "cannot be more than five minutes in the future");
  }

  if (
    isEntitled &&
    !isPartial &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(status) &&
    (!productId || !expirationDate)
  ) {
    fail(
      !productId ? "productId" : "expirationDate",
      "is required for an entitled active subscription"
    );
  }

  return {
    source: "client_unverified",
    verified: false,
    status,
    isEntitled,
    isSubscribed: deriveIsSubscribed(status, isEntitled, {
      productId,
      expirationDate,
      checkedAt,
      isPartial,
      nowMs,
    }),
    productId,
    expirationDate,
    checkedAt,
    willAutoRenew: normalizeOptionalBoolean(
      snapshot.willAutoRenew,
      "willAutoRenew"
    ),
    isPartial,
  };
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (hasOwn(row, key) && row[key] !== undefined) return row[key];
  }
  return undefined;
}

function normalizeStoredStatus(value) {
  if (value === undefined || value === null || value === "") {
    return "not_subscribed";
  }
  return typeof value === "string" && KNOWN_SUBSCRIPTION_STATUS_SET.has(value)
    ? value
    : "unknown";
}

function normalizeStoredBoolean(value) {
  return value === true || value === 1;
}

function normalizeStoredProductId(value) {
  try {
    return normalizeOptionalProductId(value);
  } catch {
    return null;
  }
}

function normalizeStoredDate(value, field) {
  try {
    return normalizeOptionalIsoDate(value, field);
  } catch {
    return null;
  }
}

/**
 * Convert either a subscription-table row or a users query with
 * `subscription_*` aliases into the stable public API shape. SQLite booleans
 * are represented by 0/1, so they are normalized explicitly.
 */
export function subscriptionRowToPublic(row) {
  const source = isRecord(row) ? row : {};
  const status = normalizeStoredStatus(
    firstDefined(source, ["subscription_status", "status"])
  );
  const isEntitled = normalizeStoredBoolean(
    firstDefined(source, [
      "subscription_is_entitled",
      "is_entitled",
      "isEntitled",
    ])
  );
  const productId = normalizeStoredProductId(
    firstDefined(source, [
      "subscription_product_id",
      "product_id",
      "productId",
    ])
  );
  const expirationDate = normalizeStoredDate(
    firstDefined(source, [
      "subscription_expiration_date",
      "expiration_date",
      "expirationDate",
    ]),
    "expirationDate"
  );
  const checkedAt = normalizeStoredDate(
    firstDefined(source, [
      "subscription_checked_at",
      "checked_at",
      "checkedAt",
    ]),
    "checkedAt"
  );
  const isPartial = normalizeStoredBoolean(
    firstDefined(source, [
      "subscription_is_partial",
      "is_partial",
      "isPartial",
    ])
  );

  return {
    // These rows currently originate only from a client StoreKit snapshot.
    // Keep that provenance explicit so callers never mistake it for receipt
    // or App Store Server API verification.
    source: "client_unverified",
    verified: false,
    status,
    isEntitled,
    isSubscribed: deriveIsSubscribed(status, isEntitled, {
      productId,
      expirationDate,
      checkedAt,
      isPartial,
    }),
    productId,
    expirationDate,
    checkedAt,
    willAutoRenew: normalizeStoredBoolean(
      firstDefined(source, [
        "subscription_will_auto_renew",
        "will_auto_renew",
        "willAutoRenew",
      ])
    ),
    isPartial,
  };
}
