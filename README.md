# mobileSearcherBackend

## Verified Apple subscriptions

Every Firebase user receives a stable, server-generated UUID in
`GET /api/session` as `apple.appAccountToken`. The iOS StoreKit 2 purchase call
must pass that UUID as its `appAccountToken`, then send Apple's signed JWS to:

```http
POST /api/subscriptions/apple/verify
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
  "source": "purchase",
  "evidence": [
    {
      "signedTransactionInfo": "<Apple JWS>",
      "signedRenewalInfo": "<optional Apple JWS>"
    }
  ]
}
```

`source` may be `purchase`, `restore`, `refresh`, or `transaction_update`.
The server uses Apple's official `@apple/app-store-server-library` to verify
the certificate chain, requires the signed account token to match the
authenticated Firebase user, validates the product against the plan catalog,
queries current App Store Server API status, and uniquely binds the
environment/original-transaction chain to that UID. The response contains
`acceptedTransactionIds` (which the app may then finish) and the refreshed
authoritative `session`.

Evidence items and transaction chains are processed independently. A partial
success returns every safe-to-finish transaction ID plus entries shaped as
`{ "index", "code", "retryable" }` in `rejected` and a `rejectedCount`; it
never echoes signed JWS data. If no evidence can be accepted, the endpoint
returns an appropriate non-2xx error with the same safe rejection metadata.

Deleting an app account still proceeds normally. A pseudonymous ownership
tombstone containing only the Apple environment, original transaction ID, and
random app account token survives deletion so the same transaction chain cannot
later be claimed by a different Firebase account. Document this retained
anti-fraud binding in the privacy policy and define an appropriate retention
period.

There is intentionally no tokenless legacy-purchase claim path. A restored
transaction without this user's token is rejected. This is appropriate before
the first public release; adding legacy support later requires an explicit
ownership-migration design. The verifier also requires StoreKit ownership type
`PURCHASED`; leave Family Sharing disabled for these products unless a separate
family entitlement policy is implemented.

`POST /api/subscriptions/apple/refresh` requeries an already-linked
subscription for the authenticated user. Configure App Store Server
Notifications V2 to call:

```text
POST /api/webhooks/apple/app-store-server-notifications-v2
```

The webhook verifies the outer and nested Apple JWS values, deduplicates
`notificationUUID`, enforces transaction-chain ownership, and applies only
newer signed state. It authenticates with Apple's signature, not Firebase.
Application work is bounded by a small concurrency guard; saturation returns
`503` with `Retry-After` so Apple can retry. Configure request-rate protection
at the deployment edge/WAF as well. Do not add `req.ip`-based application
limits behind a reverse proxy unless Express `trust proxy` is configured only
for known proxy hops and forwarded headers are sanitized by that proxy.

Required runtime configuration:

```text
APPLE_BUNDLE_ID=com.chilltech.pantrio
APPLE_APP_ID=<numeric App Store app id; required for Production>
APPLE_IAP_KEY_ID=<In-App Purchase key id>
APPLE_IAP_ISSUER_ID=<issuer uuid>
APPLE_IAP_PRIVATE_KEY_BASE64=<base64 p8 contents>
APPLE_ROOT_CERTIFICATES_BASE64_JSON=["<base64 DER Apple root>"]
APPLE_ALLOWED_ENVIRONMENTS=Production
APPLE_ALLOW_SANDBOX_IN_PRODUCTION=false
```

The default allowed environment is `Sandbox` outside production and
`Production` when `NODE_ENV=production`. Production rejects Sandbox even if it
is listed unless `APPLE_ALLOW_SANDBOX_IN_PRODUCTION` is set to the literal value
`true`. Enabling that switch makes production accept both Production and
Sandbox transactions, regardless of `APPLE_ALLOWED_ENVIRONMENTS`; this is
intended only for a tightly controlled TestFlight/App Review window. Sandbox
transactions do not represent real payment, so leaving the switch enabled can
grant paid entitlements without revenue. Keep it `false` during normal public
operation, restrict access to the backend while it is enabled, and disable it
after testing. Restart or redeploy the backend after changing the switch because
the Apple verifier clients are initialized once per process. Keep the `.p8` key
and certificates in
deployment secrets, never in the repository or mobile bundle.
`APPLE_IAP_PRIVATE_KEY` and comma-separated
`APPLE_ROOT_CERTIFICATE_PATHS` are also supported for local development.

## Sign in with Apple account-deletion revocation

This is separate from StoreKit subscription verification. Immediately after a
native Apple login, the authenticated client sends Apple's single-use
authorization code to:

```http
POST /api/auth/apple/link
Authorization: Bearer <fresh Firebase ID token>
Content-Type: application/json

{ "authorizationCode": "<Apple authorization code>" }
```

The endpoint accepts only a recent Firebase session whose current provider is
`apple.com`. It exchanges the code with Apple, verifies Apple's signed identity
token, checks that its subject equals the Firebase user's linked Apple provider
UID, and stores the refresh token encrypted with AES-256-GCM.

Account deletion is a durable, idempotent workflow:

```http
DELETE /api/users/<firebase-uid>
Authorization: Bearer <Firebase ID token>

GET /api/users/<firebase-uid>/deletion-status
Authorization: Bearer <same still-unexpired Firebase ID token>
```

Starting a deletion requires an active Firebase session with `auth_time` no
more than 600 seconds old, regardless of sign-in provider. A stale session gets
`403 RECENT_AUTH_REQUIRED`. Once the deletion tombstone exists, repeated
`DELETE` calls and `GET .../deletion-status` are UID-scoped and use the signed,
unexpired token for response-loss reconciliation even after Firebase removes
the user. Other authenticated HTTP and WebSocket operations return `410
ACCOUNT_DELETION_IN_PROGRESS` or `410 ACCOUNT_DELETED` for that tombstone and
cannot provision new local data.

A completed deletion returns HTTP 200. A durably accepted workflow with remote
cleanup still pending returns HTTP 202; in that response `ok: false` means "not
complete yet," not that the deletion request was rejected. Both routes use the
same status shape:

```json
{
  "ok": false,
  "uid": "firebase-uid",
  "deletionStatus": "processing",
  "firebaseStatus": "deleted",
  "localDataStatus": "deleted",
  "appleSignInRevocation": "pending",
  "appleRetryAt": "2026-08-10T20:00:00.000Z",
  "retryable": true,
  "requestedAt": "2026-08-10T19:59:00.000Z",
  "updatedAt": "2026-08-10T19:59:00.000Z",
  "completedAt": null
}
```

Transient Apple failures keep the encrypted credential only in the durable
deletion record and retry with bounded backoff while Firebase and local-data
cleanup continue. A successful revocation records `revoked` and clears the
credential. If an older Apple account has no captured token, configuration is
unusable, or bounded retries are exhausted, deletion completes with
`appleSignInRevocation: "manual_required"` so the client can direct the person
to stop using Pantrio in their Apple Account settings. Revocation does not
cancel an App Store subscription.

Configure a Sign in with Apple key associated with the native App ID. Do not
reuse the App Store Connect issuer/key settings above:

```text
APPLE_SIGN_IN_CLIENT_ID=com.chilltech.pantrio
APPLE_SIGN_IN_TEAM_ID=<10-character Apple Developer Team ID>
APPLE_SIGN_IN_KEY_ID=<Sign in with Apple key ID>
APPLE_SIGN_IN_PRIVATE_KEY_BASE64=<base64 p8 contents>
APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_BASE64=<base64 random 32-byte key>
APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY_ID=v1
```

Keep both keys in deployment secrets. Changing the encryption key without a
key-rotation migration makes existing refresh tokens unreadable.

## Flexible subscription plan catalog

Products and server-side capabilities are controlled by validated
`APPLE_SUBSCRIPTION_PLANS_JSON`:

```json
[
  {
    "id": "starter",
    "name": "Pantrio Starter",
    "productIds": ["com.chilltech.pantrio.starter.monthly"],
    "dailyTokenLimit": 50000,
    "defaultModel": "gpt-5-mini",
    "allowedModels": ["gpt-5-mini"],
    "maxCompletionTokens": 1000,
    "maxPromptTokens": 25000
  },
  {
    "id": "pro",
    "name": "Pantrio Pro",
    "productIds": [
      "com.chilltech.pantrio.subscription.monthly",
      "com.chilltech.pantrio.subscription.yearly"
    ],
    "dailyTokenLimit": null,
    "defaultModel": "gpt-5",
    "allowedModels": ["gpt-5", "gpt-5-mini", "gpt-4o", "gpt-4o-mini"],
    "maxCompletionTokens": 4000,
    "maxPromptTokens": 50000
  }
]
```

Product IDs must be unique across plans. The default model must be present in
the plan's allowed models, and every model must be supported by this server.
`defaultModel` and `allowedModels` govern interactive WebSocket chat. Internal
memory summarization intentionally remains on the fixed safe
`gpt-4o-mini` model while still honoring the plan's prompt, completion, and
daily-token caps.
Invalid configuration stops startup. `dailyTokenLimit: null` means no daily
quota; a positive integer creates a quota-limited paid tier. If a user has
multiple simultaneous active plans, the last matching plan in the catalog has
priority, so list plans from lowest to highest entitlement. Keep retired
product IDs configured while their transaction chains may still send
notifications. When the variable is omitted, the current monthly/yearly Pro
catalog is used. The built-in free plan remains 20,000 daily tokens,
`gpt-5-mini`, and 600 completion tokens.

## Client subscription telemetry

The mobile client can synchronize its StoreKit status after each refresh with
an authenticated request:

```http
PATCH /api/users/me
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
  "subscription": {
    "status": "subscribed",
    "isEntitled": true,
    "productId": "com.chilltech.pantrio.subscription.monthly",
    "expirationDate": "2026-09-08T00:00:00Z",
    "checkedAt": "2026-08-08T00:00:00Z",
    "willAutoRenew": true,
    "isPartial": false
  }
}
```

`POST /api/users` accepts the same optional `subscription` object. Profile
responses return the normalized object as `subscription`. Missing, invalid,
unknown, expired, revoked, billing-retry, and unsupported statuses all fail
closed for reported subscription state. An active report requires an entitled
`subscribed` or `in_grace_period` snapshot with a product ID, expiration date,
and fresh `checkedAt` value. Active snapshots fail closed after 24 hours without
a new client sync, on expired normal subscriptions, or when StoreKit reports a
partial result. Older `checkedAt` snapshots cannot overwrite newer stored state.

Client-reported StoreKit state can be forged by a modified client, so an
unverified report does not bypass quota by default. Verified Apple state always
takes precedence over this telemetry, including verified expiration or
revocation. Local non-production environments may temporarily set
`ALLOW_UNVERIFIED_SUBSCRIPTIONS=true`; the flag is ignored in production.

## Non-subscriber token quota

Authenticated users without verified subscription access receive 20,000 total
tokens per Los Angeles calendar day and at most 600 completion tokens per
text-model round. Usage is keyed by Firebase UID. Chat tool-continuation rounds,
summarization, and transcription usage reported by OpenAI all count toward the
daily total. WebSocket chat requires a valid Firebase ID token; client-selected
guest or trial IDs are not accepted as quota identities.

WebSocket chat requests from non-subscribers are always executed with
`gpt-5-mini`, even if the client requests another model. Verified subscribers
receive the daily limit, default/allowed models, completion cap, and prompt cap
configured for their specific plan.

Text/tool requests reserve `ceil(serialized UTF-8 bytes / 3)` tokens plus the
existing per-message and response overheads. Image messages use a separate
vision reservation so base64 camera data is not counted as text. Transcription
has no provider-side token cap, so non-subscriber audio must fit a reservation
of `ceil(file bytes / 64) + 256` tokens before it is uploaded. Provider-reported
usage is authoritative when successful reservations are reconciled.

Authenticated clients should bootstrap with `GET /api/session` and treat its
entitlement, quota, and effective-model fields as authoritative. Subscription
sync and `/summarize` requests require a Firebase Bearer token.

The session response is shaped as:

```json
{
  "user": { "uid": "firebase-uid", "username": "name" },
  "entitlement": {
    "plan": "free",
    "active": false,
    "source": "client_unverified",
    "verified": false
  },
  "quota": {
    "applies": true,
    "limit": 20000,
    "used": 0,
    "reserved": 0,
    "remaining": 20000,
    "timezone": "America/Los_Angeles",
    "resetsAt": "2026-08-09T07:00:00.000Z"
  },
  "model": {
    "requested": null,
    "effective": "gpt-5-mini",
    "restricted": true
  },
  "apple": {
    "enabled": true,
    "appAccountToken": "82fcc41e-701a-4975-ad87-bf74cc4b46ec",
    "products": [
      {
        "productId": "com.chilltech.pantrio.subscription.monthly",
        "planId": "pro",
        "displayName": "Pantrio Pro"
      }
    ]
  }
}
```

Quota and rate failures use terminal `{ "type": "error", "code", "message",
"quota" }` WebSocket messages. HTTP AI endpoints use the same `code`, `error`,
and nested `quota` fields. WebSocket payloads are capped at 8 MiB, starts accept
at most 50 bounded-complexity messages, and tool continuations stop after six
rounds. Audio uploads are capped at 2 MiB; the mobile client records at most 60
seconds at 32 kbps.

## Deployment note

Set `SQLITE_PATH` to a persistent mounted volume in production. Daily usage,
profiles, Apple account bindings, verified transactions, notification
deduplication, subscription reports, and the account-deletion retry outbox live
in that database; an ephemeral app filesystem can lose pending cleanup work on
redeploy. This implementation also assumes one backend replica because
per-account deletion/link locks and WebSocket/REST burst limits are held in
memory. Move the locks, rate limits, quota reservations, and deletion worker to
a shared datastore before scaling to multiple replicas.

Server startup requires `NODE_ENV` to be explicitly set to `development`,
`test`, or `production`. Production additionally requires an absolute
`SQLITE_PATH` and `BACKEND_REPLICA_COUNT=1`; if the host sets
`WEB_CONCURRENCY`, it must also be `1`. This makes the single-replica assumption
visible in deployment configuration and fails startup before unsafe production
traffic is accepted. Use `/live` for process liveness and `/ready` (or the
backward-compatible `/health`) for traffic readiness; readiness returns 503
while draining or when SQLite cannot answer.

This service uses Firebase Admin Authentication only, so production installs
may use `npm ci --omit=dev --omit=optional` to exclude Firebase's unused
optional Firestore and Storage dependency trees. Revisit that install command
before adding either service.
