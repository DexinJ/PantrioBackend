import path from "node:path";

const NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);

export function parseNodeEnvironment(value) {
  const normalized = String(value || "development").trim().toLowerCase();
  if (!NODE_ENVIRONMENTS.has(normalized)) {
    throw new Error(
      "NODE_ENV must be one of: development, test, production."
    );
  }
  return normalized;
}

export function requireNodeEnvironment(value) {
  if (!String(value ?? "").trim()) {
    throw new Error(
      "NODE_ENV is required and must be one of: development, test, production."
    );
  }
  return parseNodeEnvironment(value);
}

export function parsePort(value) {
  const normalized = value === undefined || value === null || value === ""
    ? 3000
    : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
  }
  return normalized;
}

export function resolveSqlitePath(
  environment,
  { cwd = process.cwd() } = {}
) {
  const nodeEnvironment = parseNodeEnvironment(environment.NODE_ENV);
  const configuredPath = String(environment.SQLITE_PATH || "").trim();
  if (nodeEnvironment === "production") {
    if (!configuredPath || !path.isAbsolute(configuredPath)) {
      throw new Error(
        "Production requires SQLITE_PATH to be an absolute path on persistent storage."
      );
    }
    return configuredPath;
  }
  return configuredPath || path.join(cwd, "data.sqlite");
}

export function validateFirebaseCredentialSources(environment) {
  const hasJson = Boolean(
    String(environment.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim()
  );
  const hasPath = Boolean(
    String(environment.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim()
  );
  if (hasJson === hasPath) {
    throw new Error(
      "Set exactly one of FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH."
    );
  }
  return hasJson ? "json" : "path";
}

export function validateSingleReplicaEnvironment(environment) {
  if (parseNodeEnvironment(environment.NODE_ENV) !== "production") return;

  const backendReplicaCount = String(
    environment.BACKEND_REPLICA_COUNT ?? ""
  ).trim();
  if (backendReplicaCount !== "1") {
    throw new Error(
      "Production requires BACKEND_REPLICA_COUNT=1 while SQLite, locks, and rate limits are process-local."
    );
  }

  const webConcurrency = String(environment.WEB_CONCURRENCY ?? "").trim();
  if (webConcurrency && webConcurrency !== "1") {
    throw new Error(
      "WEB_CONCURRENCY must be 1 while SQLite, locks, and rate limits are process-local."
    );
  }
}
