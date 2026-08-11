PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Users (authed only)
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  apple_app_account_token TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  subscription_status TEXT NOT NULL DEFAULT 'unknown',
  subscription_is_entitled INTEGER NOT NULL DEFAULT 0 CHECK(subscription_is_entitled IN (0, 1)),
  subscription_product_id TEXT DEFAULT NULL,
  subscription_expiration_date TEXT DEFAULT NULL,
  subscription_checked_at TEXT DEFAULT NULL,
  subscription_will_auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(subscription_will_auto_renew IN (0, 1)),
  subscription_is_partial INTEGER NOT NULL DEFAULT 0 CHECK(subscription_is_partial IN (0, 1)),
  subscription_updated_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Sign in with Apple refresh tokens are encrypted by the application before
-- storage. This credential is distinct from StoreKit's appAccountToken below
-- and is retained only while its Firebase user exists.
CREATE TABLE IF NOT EXISTS apple_sign_in_credentials (
  firebase_uid TEXT PRIMARY KEY,
  apple_subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(client_id, apple_subject),
  FOREIGN KEY(firebase_uid) REFERENCES users(uid) ON DELETE CASCADE
);

-- Durable account-deletion tombstones deliberately have no users foreign key.
-- They block cached Firebase sessions from recreating an account, make the
-- cross-service workflow restartable, and preserve the non-secret Apple
-- revocation outcome after the user row and encrypted login credential are
-- removed.
CREATE TABLE IF NOT EXISTS account_deletions (
  firebase_uid TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('processing', 'complete')),
  firebase_status TEXT NOT NULL CHECK(firebase_status IN ('pending', 'deleted')),
  local_data_status TEXT NOT NULL CHECK(local_data_status IN ('pending', 'deleted')),
  apple_identity_linked INTEGER NOT NULL CHECK(apple_identity_linked IN (0, 1)),
  apple_revocation_status TEXT NOT NULL CHECK(
    apple_revocation_status IN ('pending', 'revoked', 'manual_required', 'not_linked')
  ),
  apple_subject TEXT,
  apple_client_id TEXT,
  encrypted_apple_refresh_token TEXT,
  apple_revocation_attempts INTEGER NOT NULL DEFAULT 0,
  apple_next_retry_at INTEGER,
  firebase_deletion_attempts INTEGER NOT NULL DEFAULT 0,
  firebase_next_retry_at INTEGER,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT
);

-- Verified App Store subscription state. Client StoreKit telemetry remains on
-- users for diagnostics, but these rows are the only production entitlement
-- authority.
CREATE TABLE IF NOT EXISTS apple_subscriptions (
  environment TEXT NOT NULL CHECK(environment IN ('Production', 'Sandbox')),
  original_transaction_id TEXT NOT NULL,
  firebase_uid TEXT NOT NULL,
  latest_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status INTEGER NOT NULL CHECK(status BETWEEN 1 AND 5),
  expires_at INTEGER,
  grace_expires_at INTEGER,
  auto_renew_status INTEGER CHECK(auto_renew_status IN (0, 1)),
  revoked_at INTEGER,
  signed_date INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(environment, original_transaction_id),
  FOREIGN KEY(firebase_uid) REFERENCES users(uid) ON DELETE CASCADE
);

-- Pseudonymous ownership tombstone. It contains no Firebase UID and
-- intentionally survives account deletion so an App Store transaction chain
-- cannot later be claimed by a different app account.
CREATE TABLE IF NOT EXISTS apple_subscription_ownership (
  environment TEXT NOT NULL CHECK(environment IN ('Production', 'Sandbox')),
  original_transaction_id TEXT NOT NULL,
  app_account_token TEXT NOT NULL,
  first_verified_at INTEGER NOT NULL,
  PRIMARY KEY(environment, original_transaction_id)
);

CREATE TABLE IF NOT EXISTS apple_transactions (
  environment TEXT NOT NULL CHECK(environment IN ('Production', 'Sandbox')),
  transaction_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  firebase_uid TEXT NOT NULL,
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  purchase_date INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  signed_date INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(environment, transaction_id),
  FOREIGN KEY(firebase_uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS apple_notification_events (
  environment TEXT NOT NULL CHECK(environment IN ('Production', 'Sandbox')),
  notification_uuid TEXT NOT NULL,
  notification_type TEXT,
  subtype TEXT,
  firebase_uid TEXT,
  signed_date INTEGER,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY(environment, notification_uuid),
  FOREIGN KEY(firebase_uid) REFERENCES users(uid) ON DELETE SET NULL
);

-- Trial devices (trialId)
CREATE TABLE IF NOT EXISTS trial_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','trial')),
  owner_key TEXT NOT NULL,                -- firebase_uid OR trial_id
  model TEXT NOT NULL,
  language TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Messages (chat history)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Daily usage for trial/users (token budgets)
CREATE TABLE IF NOT EXISTS usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','trial')),
  owner_key TEXT NOT NULL,                -- firebase_uid OR trial_id
  day_key TEXT NOT NULL,                  -- 'YYYY-MM-DD' in server timezone
  tokens_used INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_type, owner_key, day_key)
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_type, owner_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user ON apple_subscriptions(firebase_uid, verified_at);
CREATE INDEX IF NOT EXISTS idx_apple_subscriptions_user_environment
  ON apple_subscriptions(firebase_uid, environment, verified_at DESC);
CREATE INDEX IF NOT EXISTS idx_apple_transactions_original ON apple_transactions(environment, original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_apple_transactions_user ON apple_transactions(firebase_uid, signed_date);
CREATE INDEX IF NOT EXISTS idx_account_deletions_status ON account_deletions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_account_deletions_recovery
  ON account_deletions(status, apple_next_retry_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_account_deletions_firebase_recovery
  ON account_deletions(status, firebase_next_retry_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_apple_notification_events_processed
  ON apple_notification_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day_key ON usage_daily(day_key);

-- These guards close the narrow race where a request verifies Firebase just
-- before deletion creates its tombstone and then attempts a user-scoped insert
-- after local cleanup. On the shared SQLite connection, either the insert
-- commits before the tombstone (and cleanup removes it) or the trigger blocks
-- the insert after the tombstone exists.
CREATE TRIGGER IF NOT EXISTS prevent_deleted_user_insert
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1 FROM account_deletions
   WHERE firebase_uid = NEW.uid
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_DELETION_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS prevent_deleted_user_usage_insert
BEFORE INSERT ON usage_daily
WHEN NEW.owner_type = 'user' AND EXISTS (
  SELECT 1 FROM account_deletions
   WHERE firebase_uid = NEW.owner_key
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_DELETION_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS prevent_deleted_user_conversation_insert
BEFORE INSERT ON conversations
WHEN NEW.owner_type = 'user' AND EXISTS (
  SELECT 1 FROM account_deletions
   WHERE firebase_uid = NEW.owner_key
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_DELETION_BLOCKED');
END;
