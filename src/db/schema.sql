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
CREATE INDEX IF NOT EXISTS idx_apple_transactions_original ON apple_transactions(environment, original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_apple_transactions_user ON apple_transactions(firebase_uid, signed_date);
