# Apple subscription claim redesign

Status: backend and app code changes are implemented; see "Implementation
status" below. Revised after simulation — see section 5.
Scope: `mobileSearcherBackend` (primary) and `fridge-manager` / Pantrio iOS app.
Owner decision pending: see [Open decisions](#open-decisions).

### Implementation status

Landed:

* Backend — owner-aware ownership invariant (`assertAppleOwnershipState` plus the
  three-branch ownership upsert), `getAppleChainClaimState`,
  `classifyAppleChainClaim`, `findUserByAppleChain`,
  `getAppleSubscriptionRefreshTargets`, `releaseAppleOwnershipForUser`, the
  per-chain keyed lock in `saveVerifiedAppleState`, chain-first claim resolution
  in `verifyAppleEvidenceForUser`, refresh-all-chains, chain-first notification
  resolution with `matchedBy`, schema and account-deletion comments,
  `validatePersistentStorageEnvironment` plus the startup storage log, and
  `scripts/apple-ownership-maintenance.mjs` (smoke-tested: dry run, backup,
  orphan-only delete).
* App — unfiltered evidence submission (`evidenceForAppAccount` now orders rather
  than filters), no client-side token-mismatch throw, and benign-error
  suppression on both background paths (app-open reconcile and the
  `transaction_update` listener). Native evidence now sorts newest-first.

Not landed:

* Settings copy and locale strings for the adoption outcome (`acceptedItems`
  response enrichment was not needed for the behavior, so the UI keeps its
  existing "restored" message).
* App-side unit tests for the submission/error-classification policy, because
  extracting the pure module was scoped out of this pass.
* Any Railway configuration change — the volume, `NODE_ENV=production`,
  `BACKEND_REPLICA_COUNT=1` and the sandbox switch are yours to apply.
* A new iOS build: the native evidence-ordering change alters the runtime
  fingerprint, so it cannot ship over the air.

---

## 1. Problem

An App Store subscription chain is currently bound to one Pantrio account
**forever**, and the binding outlives the account that created it. When a user
deletes their Pantrio account, the subscription they paid for becomes
unclaimable by anyone, including that same person later signing in again.

### 1.1 How the current code produces that

A chain is identified by `(environment, original_transaction_id)` and carries two
independent bindings:

* **Token binding** — the signed transaction contains `appAccountToken = T_A`.
  `requireMatchingAccountToken()` in `src/subscriptions/appleSubscriptionService.js`
  rejects any verification where the transaction token does not equal the
  verifying account's `users.apple_app_account_token`.
* **Chain binding** — `apple_subscription_ownership(environment,
  original_transaction_id, app_account_token = T_A)`. It has no foreign key to
  `users` and no code path ever deletes it.

On account deletion, `purgeLocalAccountData()` in
`src/accountDeletion/accountDeletionService.js` runs `DELETE FROM users WHERE uid = ?`,
which cascades away `apple_subscriptions`, `apple_transactions`, and
`apple_sign_in_credentials`. The ownership row survives by design.

Result after deletion:

1. `T_A` exists nowhere in the database, so no account can ever satisfy the
   token binding. The still-active subscription cannot be restored by anyone.
2. If Apple reissues the chain on a re-purchase (same `originalTransactionId`),
   the new transaction carries `T_B` and `assertAppleOwnershipState()` throws
   `AppleSubscriptionOwnershipError` — HTTP 409, "This App Store subscription is
   already linked to another account."
3. If Apple instead issues a new chain, the re-purchase happens to work. Which
   of (2) or (3) occurs is Apple's choice, not ours, so the outcome is
   nondeterministic.

The tombstone therefore protects nobody in this scenario: there is no live owner
left to protect, and the payer is locked out of what they bought.

### 1.2 Additional defect found while diagnosing

The deployed backend runs with `NODE_ENV=development`, `SQLITE_PATH=./data.sqlite`,
and no attached Railway volume. Production startup validation
(`resolveSqlitePath`, `validateSingleReplicaEnvironment`) is therefore skipped,
the container filesystem is ephemeral, and every deploy starts from an empty
database. That is a separate, higher-severity defect (see
[Appendix B](#appendix-b-production-findings-2026-09-29)) and it must be fixed
before any of the work below can be verified.

---

## 2. Goals and non-goals

Goals:

* One subscription chain may not simultaneously entitle two live Pantrio accounts.
* A user who deletes their account and signs in again can reclaim the
  subscription they paid for, without support intervention.
* Renewals, refunds, and expirations continue to reach the correct account,
  including after that reclaim.
* Behavior is deterministic: the outcome must not depend on whether Apple
  reuses a chain identifier.

Non-goals:

* Matching Pantrio accounts to Apple IDs. Apple does not expose the Apple ID
  behind an in-app purchase; the available handles are `originalTransactionId`,
  `appAccountToken`, and (iOS 18.4+) `appTransactionId`.
* Allowing a chain to move between two *live* accounts. That remains blocked and
  becomes a support/migration operation if requested.
* Changing product IDs, pricing, the StoreKit purchase call, or the App Store
  Connect catalog.

---

## 3. Target claim rules

When verified evidence arrives for account `U` on chain `C`:

| Chain state | Rule | Error code on rejection |
| --- | --- | --- |
| `apple_subscriptions` row exists and `firebase_uid = U` | Accept (renewal, refresh, transaction update, re-subscribe). The transaction token is **not** compared. | — |
| `apple_subscriptions` row exists and `firebase_uid != U` | Reject. A live account owns the chain. | `APPLE_PURCHASE_ACCOUNT_CONFLICT` (409) |
| No subscription row, ownership row exists | Released chain — the previous owner's account was deleted. **Adopt**: bind the chain to `U`. No token comparison. | — |
| No subscription row, no ownership row | First claim. Require `transaction.appAccountToken == U.apple_app_account_token`, then bind. | `APPLE_PURCHASE_ACCOUNT_MISMATCH` (409) |

Consequences:

* Blocking is derived from `apple_subscriptions`, which cascades on account
  deletion, so the release signal is automatic and cannot be forgotten.
* `apple_subscription_ownership` becomes a provenance record plus the marker of a
  released chain, not an eternal veto. **Its stored token is immutable and is
  never used as a gate.** It records which token originally claimed the chain.
  Section 5.3 shows why gating on it re-creates the wedge this project removes.
* `appAccountToken` keeps exactly one job: proving that a *new* chain was
  purchased from the account claiming it.
* An account may hold more than one chain (an adopted chain plus a later
  purchase, or two products) without any token conflicts. Section 5.5 covers the
  refresh consequence.

### 3.1 Security analysis

* Adoption requires a JWS that verifies against Apple, a released binding, and a
  successful App Store Server API status read for this app. The only party who
  can present such evidence is a device signed in to the Apple Account that owns
  the subscription, which is the same trust level as any restore-purchase flow.
* Adoption is only reachable when the previous owner's account no longer exists.
  While both accounts exist, the 409 is unchanged.
* A leaked JWS for a released chain could be used to adopt it. That is accepted
  and should be documented; the exposure is bounded by the fact that the
  original owner deleted their account.
* Because the JWS is the real gate, the stored ownership token adds no security.
  Comparing it (as the first draft of this design did) only creates a second
  failure path when the token is ever rewritten, so the comparison is dropped.
* Family Sharing must remain disabled for these products (the verifier already
  requires ownership type `PURCHASED`).
* `POST /api/subscriptions/apple/verify` already carries a 10-requests/minute
  authenticated rate limit and a 4-way concurrency guard; adoption attempts
  count against both. No new limit is required.

---

## 4. Backend changes

### 4.1 `src/subscriptions/appleSubscriptionStore.js`

#### Required — owner-aware ownership invariant

This is the fix for the defect found in simulation (section 5.4): the service
rule and the store invariant currently disagree, so an account that owns a chain
is rejected when it re-subscribes with a new token.

* `assertAppleOwnershipState()` — keep the `subscription_uid` and
  `transaction_uid` clauses unconditionally. Evaluate the ownership-token clause
  **only when the chain has no live owner that is the record's uid**, i.e. skip
  it when `existing.subscription_uid === record.uid`. The same relaxation must
  apply to the re-read assertion at the end of the write.
* The ownership upsert must admit the owning account as well as the
  token-matching first claim:

```sql
INSERT INTO apple_subscription_ownership (
  environment, original_transaction_id, app_account_token, first_verified_at
) VALUES (?, ?, ?, ?)
ON CONFLICT(environment, original_transaction_id) DO UPDATE SET
  app_account_token = apple_subscription_ownership.app_account_token
WHERE lower(apple_subscription_ownership.app_account_token) =
        lower(excluded.app_account_token)
   OR EXISTS (
        SELECT 1 FROM apple_subscriptions s
         WHERE s.environment = ?
           AND s.original_transaction_id = ?
           AND s.firebase_uid = ?
      )
RETURNING app_account_token
```

  Pass environment, chain, and uid as bound parameters; do not reference
  `excluded.*` inside the subquery. Keep `if (!ownership) throw` so a genuine
  race still fails closed. The `DO UPDATE SET` deliberately keeps the existing
  token, preserving provenance.

#### Required — one decision point

Add a single function that resolves the claim and performs the writes, for
example `persistAppleChainClaim(db, record, { outcome })`, and have the service
call it instead of `saveVerifiedAppleState()` directly. The bug in section 5.4
exists precisely because the accept/reject rule lives in one module and the
invariant in another. Encode the rule once; let the service only map outcomes to
HTTP codes.

#### Required — chain lookup helpers

* `getAppleChainClaimState(db, { environment, originalTransactionId })`
  returning `{ ownerUid, ownershipToken, transactionUid }`, reusing the existing
  `readAppleOwnershipState()` query shape.
* `findUserByAppleChain(db, { environment, originalTransactionId })` returning
  `{ uid }` from `apple_subscriptions`, used by the notification path.
* `getAppleSubscriptionRefreshTargets(db, uid)` returning **all** chains owned by
  the account, replacing the current single-row
  `getAppleSubscriptionRefreshTarget`. See section 5.5 for why.

#### Optional — keyed lock

Wrapping resolution plus writes in
`acquireKeyedLock("apple-chain:" + environment + ":" + originalTransactionId)`
(`src/utils/keyedLock.js`) is **belt-and-braces, not required**. Section 5.4
shows the existing conditional upserts plus the re-read assertion already
resolve an adoption race to one winner and one conflict, with no rows leaked to
the loser. The lock only avoids a wasted App Store Server API call, so take it
if it is cheap and skip it if it complicates the write path.

#### Ops-only

`releaseAppleOwnershipForUser(db, uid)` — deletes ownership rows for chains whose
`apple_subscriptions.firebase_uid` is `uid`. Used only by the maintenance script
(section 8.3), and only if the team later decides to remove tombstones rather
than retain them as provenance.

### 4.2 `src/subscriptions/appleSubscriptionService.js`

Replace the unconditional `requireMatchingAccountToken()` gate with a
chain-resolution step implementing section 3:

```js
async function resolveAppleChainClaim(db, { uid, accountToken, environment, transaction }) {
  const state = await getAppleChainClaimState(db, {
    environment,
    originalTransactionId: transaction.originalTransactionId,
  });
  if (state.ownerUid === uid) return { outcome: "owner" };
  if (state.ownerUid) return { outcome: "conflict" };
  if (state.ownershipToken) return { outcome: "adopt" };   // released chain; no token comparison
  return transaction.appAccountToken.toLowerCase() === accountToken.toLowerCase()
    ? { outcome: "first_claim" }
    : { outcome: "mismatch" };
}
```

Order of checks matters: the live-owner branch must precede any token logic, or
a renewal of an adopted chain (which carries the deleted account's token) is
rejected.

Ordering inside `verifyAppleEvidenceForUser()`:

1. `verifyInAnyEnvironment()` (unchanged)
2. `requireTransactionFields()` (unchanged)
3. group evidence by chain **before** per-item validation, then resolve each
   chain once and memoize per `environment:originalTransactionId`. Multiple
   evidence items commonly share a chain; resolving per item would produce
   duplicate conflict errors.
4. `decodeRenewal()` (unchanged — it only compares two Apple-signed values)
5. `persistAppleChainClaim()` with the resolved outcome and owner uid

Rejection mapping stays on the existing envelope so clients need no new error
shape:

* `conflict` → `APPLE_PURCHASE_ACCOUNT_CONFLICT` (409)
* `mismatch` → `APPLE_PURCHASE_ACCOUNT_MISMATCH` (409)

`processAppleNotification()`:

* Resolve the uid with `findUserByAppleChain()` first, then fall back to
  `findUserByAppleAccountToken()`. Reason: after adoption the chain's token
  belongs to the deleted account while the subscription row belongs to the new
  one, so a token-only lookup drops every renewal and refund. Confirmed in
  simulation (section 5.4).
* The fallback remains necessary for the first `SUBSCRIBED` notification, which
  can arrive before the client uploads evidence and before any subscription row
  exists.
* Extend the returned `{ duplicate, notificationUUID, matchedUser }` payload with
  how the match was made (`chain` or `token`) for log correlation.

`refreshAppleSubscriptionForUser()`:

* Iterate `getAppleSubscriptionRefreshTargets(db, uid)` and refresh every owned
  chain, not just the newest. Each call stays idempotent. Bound the loop by the
  number of rows the account actually owns.

### 4.3 Optional response enrichment

Additive field on the verify response so the app can distinguish outcomes:

```json
{ "acceptedItems": [{ "index": 0, "outcome": "adopt" }] }
```

`acceptedTransactionIds`, `rejected`, and `rejectedCount` keep their current
meanings, so this is not a breaking change.

### 4.4 `src/db/schema.sql`

* Rewrite the `apple_subscription_ownership` comment: it records original
  provenance (immutable token) and marks a released chain; live-owner blocking is
  derived from `apple_subscriptions`.
* Optional column `released_at INTEGER DEFAULT NULL`. See section 6.

### 4.5 `src/accountDeletion/accountDeletionService.js`

No functional change: `DELETE FROM users` already cascades the subscription row,
which is the release signal used by rule 3.

Add a comment at the `DELETE FROM users` line recording the dependency, so a
future change to that statement does not silently break chain adoption.

---

## 5. Simulation results

### 5.1 Method

The proposed rules were executed against the real schema and the real store
before writing this revision: throwaway scripts imported
`src/subscriptions/appleSubscriptionStore.js`, `subscriptionStore.js` and
`src/db/schema.sql` into an in-memory SQLite database and ran twelve scenarios
plus three probes (first claim, renewal, live-owner conflict, account deletion,
adoption, renewal after adoption, third-account conflict, adoption race,
token-changing re-subscribe, notification resolution, multi-chain refresh,
anti-sharing after adoption). See Appendix D.

Fidelity caveat: the store, schema, foreign-key cascades, and conditional upserts
were exercised for real. The resolver was a transcription of section 4.2's
pseudo-code, and JWS verification and the App Store Server API were stubbed. This
cannot catch anything that depends on live StoreKit or Apple server behavior.

### 5.2 Confirmed working

* First claim stored; renewal stored; a second live account targeting the chain
  rejected with `APPLE_PURCHASE_ACCOUNT_CONFLICT`.
* Account deletion left `subscriptions=0` with the tombstone retained and no
  stale entitlement for the deleted account.
* Adoption by a new account stored and entitled; a renewal of the adopted chain
  carrying the deleted account's token accepted (the case current code rejects).
* A third live account targeting the adopted chain rejected.
* Anti-sharing survives the relaxed invariant: a different live account with its
  own token cannot take a chain that already has a live owner.

### 5.3 Bug: gating adoption on the stored token

The first draft required the tombstone token to equal the transaction token in
the released branch. That holds only while the token is never rewritten, so the
next time anything updates it, adoption of the original transaction fails
spuriously. It also adds no security, since a JWS holder can replay any
transaction of the chain. **Resolved:** the comparison is removed (section 3 and
section 4.2).

### 5.4 Bug: the service rule and the store invariant disagreed

Observed:

```
B resubscribes with token TB    owner -> STORE ERROR APPLE_PURCHASE_ACCOUNT_CONFLICT
corrected owner token-change    stored
```

The resolver classifies the account as the chain owner, but
`assertAppleOwnershipState()` still required `ownership_token === record.appAccountToken`.
After adoption the tombstone holds the deleted account's token while the
returning user's new purchase carries theirs, so the user is rescued once and
re-wedged on the next re-subscribe — the same dead end this project removes,
reachable through a different door. The assertion runs before any write, so no
partial state was produced.

**Resolved** by the owner-aware invariant in section 4.1. Simulated result:

```
corrected adopt: stored
corrected owner token-change: stored
tombstone token preserved: true
F entitled: true
B adopting F's live chain: conflict      (anti-sharing intact)
```

### 5.5 Unintended changes and their disposition

| # | Unintended change | Disposition |
| --- | --- | --- |
| 1 | Accounts can own multiple chains, but `getAppleSubscriptionRefreshTarget` returns only the newest (`ORDER BY verified_at DESC LIMIT 1`), so `POST /refresh` never re-queries the others. A refund on a non-targeted chain keeps its last status until `expires_at` passes. | **Fix** — refresh all owned chains (section 4.2). Confirmed by simulation: two chains coexist for one account. |
| 2 | Removing the client token filter makes evidence for other accounts' chains reach the server, producing per-item rejections. | **Fix, ship-blocking** — both background paths (the app-open reconcile *and* the `transaction_update` listener) must swallow conflict/mismatch instead of setting `appleError`, or a shared Apple Account shows an error banner for someone else's purchase (section 7.1). |
| 3 | Native evidence is sorted by `transactionId` as a **string ascending** (oldest first) and the JS cap keeps the first 20, so if the list ever exceeds 20 the client drops the newest evidence. Lexicographic comparison also misorders IDs of different lengths. | **Fix** — sort newest-first in the native module (section 7.4). The 20-item cap itself already matches the server, and the 10-chain cap degrades per item rather than failing the request, so no further change is needed. |
| 4 | Restore-button visibility was assumed to depend on the local StoreKit snapshot. | **No change needed** — verified in `app/(tabs)/settings.js`: Restore renders whenever `Platform.OS === "ios"`; the `entitlement?.active \|\| subscription?.productId` condition guards the *Manage* button only. |
| 5 | Local "subscribed" versus server "free" until adoption runs. | **Document + copy** — foreground reconcile adopts on app open once unfiltered evidence is sent, so the state is transient. Add a "checking your App Store purchase…" string. |
| 6 | Sandbox-adopted chains disappear when the sandbox switch is turned off, because `getVerifiedAppleSubscription` filters by allowed environments. | **Document** — runbook note alongside the planned sandbox-row purge. |
| 7 | One tombstone row per chain, retained forever. | **Document** — retention policy; the maintenance script reports the count. |

### 5.6 Corrections applied to this document

1. Rule 3 no longer compares tokens (5.3).
2. The owner-aware ownership invariant is required, not optional (5.4).
3. The keyed lock is downgraded from required to belt-and-braces (5.4).
4. `refreshAppleSubscriptionForUser` now refreshes all chains; the previous
   "needs no change" statement was wrong (5.5).
5. App-side background conflict suppression is ship-blocking (5.5).
6. New native-module evidence ordering fix (5.5).
7. New test cases for each of the above (section 9).

---

## 6. Schema and migration (only if `released_at` is adopted)

Follow the existing additive pattern in `src/db/initDb.js`:

1. Add `APPLE_OWNERSHIP_COLUMN_MIGRATIONS` with
   `ALTER TABLE apple_subscription_ownership ADD COLUMN released_at INTEGER DEFAULT NULL`.
2. Add `migrateAppleOwnershipColumns(db)` and call it in both migration passes
   inside `applyDatabaseSchema()`.
3. Bump `DATABASE_SCHEMA_VERSION` from 2 to 3.

Nothing in the claim rules depends on the column, so it can be dropped from this
change without affecting behavior. Rolling the code back is safe either way,
since the column is nullable and additive.

---

## 7. App changes (`fridge-manager`)

### 7.1 `context/AccountSessionContext.js`

These are load-bearing, not cosmetic:

* `evidenceForAppAccount()` currently drops any evidence whose `appAccountToken`
  differs from the signed-in account. That filter hides exactly the released
  chain the server must adjudicate. Send all evidence and rely on the server
  verdict; keep the existing dedupe and size cap.
* `normalizeAppleEvidence()` throws a client-side
  `APPLE_ACCOUNT_TOKEN_MISMATCH` ("This Apple transaction belongs to a different
  Pantrio account."). Remove the throw; the server is authoritative. The check
  would also reject ordinary renewals of an adopted chain.
* `restoreApplePurchases()` skips verification when the token filter matched
  nothing. It must attempt verification whenever any evidence exists.
* **Interactive versus background error handling (ship-blocking).** Only
  `purchaseApplePlan` and a user-tapped `restoreApplePurchases` (and an explicit
  user-triggered refresh) may set `appleError`. Every other entry point must log
  and drop `APPLE_PURCHASE_ACCOUNT_CONFLICT` and
  `APPLE_PURCHASE_ACCOUNT_MISMATCH`. Thread an interactivity flag through
  `verifyAppleEvidence` rather than inferring it, and classify **all five**
  current call sites:

  | Call site | Trigger | May set `appleError` |
  | --- | --- | --- |
  | `purchaseApplePlan` (~line 964) | user taps Subscribe | yes |
  | `restoreApplePurchases` (~line 1023) | user taps Restore | yes |
  | `refreshAppleSubscription` → `reconcileAppleSubscription` (~line 1053) | user taps refresh | yes |
  | `reconcileAppleSubscriptionInBackground` (~line 847), error surfaces from the bootstrap effect (~line 1205) | app open | no |
  | `latestTransactionEvent` effect → `verifyAppleEvidence(..., "transaction_update", ...)` (~line 1238) | StoreKit push (renewal, refund, another account's purchase) | no |

  The transaction-update listener is the easiest one to miss and the most likely
  to fire for a chain that belongs to a different Pantrio account, because
  StoreKit delivers those updates for whatever Apple Account the device is
  signed in with.
* `verifyAppleEvidence()`: interpret `rejected[]`; all-rejected with either
  conflict code maps to a specific interactive message; any accepted item
  remains a success. Adoption reporting uses `acceptedItems[].outcome`.
* Extract the submission and error-classification decision into a pure module
  (for example `context/appleClaimPolicy.js`) so it is unit-testable without
  React.

### 7.2 `app/(tabs)/settings.js`

* Distinguish three outcomes in the subscription card: restored to this account,
  active on another Pantrio account (409 from a live owner), and adopted after a
  previous account was deleted.
* Restore Purchases is already rendered unconditionally on iOS (verified in the
  current code), so adoption does not depend on the local StoreKit snapshot
  reporting a product. Nothing to change here.
* Add a "checking your App Store purchase…" state for the window where the local
  snapshot says subscribed and the server entitlement has not caught up.
* Add an optional diagnostic row showing environment (`Sandbox` / `Production`)
  and the active `productId`. This is the missing information that made the
  TestFlight investigation slow.

### 7.3 `locales/en.json`, `locales/zh.json`

Add the new strings and retire the ones describing the old "belongs to a
different account" dead end. Only these two locale files exist.

### 7.4 `modules/apple-subscriptions/ios/AppleSubscriptionsModule.swift`

* Sort evidence newest-first instead of by string-ascending `transactionId`, in
  `currentAndUnfinishedEvidence` and `unfinishedEvidence`. Prefer the numeric
  `purchaseDate` where available; otherwise compare `transactionId` numerically.
  This only matters when the list exceeds the 20-item cap, but it determines
  *which* evidence survives.
* No other native change: the module already returns the signed transaction,
  renewal info, `appAccountToken`, and environment.

---

## 8. Operations and configuration

### 8.1 Railway (must land first)

* Attach a volume and mount it at `/data`.
* `SQLITE_PATH=/data/data.sqlite` (absolute).
* `NODE_ENV=production`.
* `BACKEND_REPLICA_COUNT=1`.
* Keep `APPLE_ALLOWED_ENVIRONMENTS=Production` with
  `APPLE_ALLOW_SANDBOX_IN_PRODUCTION=true`.
  * In production the sandbox switch is the only way to accept sandbox
    transactions; simply listing `Sandbox` in `APPLE_ALLOWED_ENVIRONMENTS`
    throws at startup.
  * The switch must stay on through App Review, because App Review exercises
    in-app purchases in the sandbox environment. Consequence: TestFlight testers
    also receive a paid entitlement while it is on.
  * Post-launch options: keep it on, or turn it off and purge rows where
    `environment = 'Sandbox'`. Turning it off drops any sandbox-adopted chain
    from `getVerifiedAppleSubscription` (section 5.5, item 6).
* The redeploy that attaches the volume discards the current ephemeral database.
  It contains no Apple state (see Appendix B), so no export is required.

### 8.2 Startup guard

Add `validatePersistentStorageEnvironment()` to `src/config/runtimeConfig.js`,
called from `src/config/env.js` next to `validateSingleReplicaEnvironment()`:

* When `NODE_ENV=production` and `RAILWAY_VOLUME_MOUNT_PATH` is set, require the
  resolved `SQLITE_PATH` to be inside that mount; otherwise throw at boot.
* When `NODE_ENV=production` and no volume mount variable is present, log a
  warning with the resolved absolute path (other hosts must not be blocked).
* Log the resolved absolute `SQLITE_PATH`, `NODE_ENV`, and the allowed Apple
  environments at startup next to the existing
  `Apple subscriptions enabled (...)` line in `src/server.js`.

This is the guard that would have caught the current outage.

### 8.3 `scripts/apple-ownership-maintenance.mjs`

* Defaults to dry-run; `--apply` required to write.
* Prints every binding: environment, `original_transaction_id`, ownership token
  (truncated), `first_verified_at` as ISO, live owner uid from `users`, live
  subscription uid from `apple_subscriptions`, and a classification
  (`live-bound`, `released`, `unbound`).
* `--release-orphans` deletes only ownership rows with no live user token and no
  live subscription row.
* Reports the total tombstone count for the retention policy.
* Always writes a `VACUUM INTO` backup on the same volume and prints the path
  before writing.
* Refuses to run when `NODE_ENV` is not `production` unless `--force` is given.

---

## 9. Test plan

### 9.1 Repository caveat

`test/` and `*.test.js` are gitignored in this repository and no test file is
tracked, so new regression tests would not be committed. Before adding them,
either:

* adjust `.gitignore` from `test/` to `test/*` and add explicit negations for the
  Apple test files, or
* `git add -f` the specific new files.

The app repository has the same situation with its `tests/` directory. Decide
once and apply it consistently; otherwise this redesign ships untested.

### 9.2 Backend unit tests

Existing harness: `openDb(t)` opening `:memory:` and executing `src/db/schema.sql`,
plus the `state(uid, overrides)` factory already shared across
`test/appleSubscriptionStore.test.js` and `test/appleSubscriptionService.test.js`.

* `appleSubscriptionStore.test.js` (extend): keep the existing "second account is
  rejected while the first is live" assertion; add token-preserved adoption and
  adoption idempotency.
* **Owner token change (regression for section 5.4):** the owning account submits
  a transaction on its chain carrying a different token — must store, must leave
  the tombstone token unchanged, and the entitlement must survive.
* **Released chain with a differing tombstone token (regression for 5.3):** must
  adopt, proving the comparison is gone.
* `appleSubscriptionService.test.js` (extend): the four rules with a stubbed
  verifier; renewal after adoption (same original token, new transaction id)
  accepted for the adopting account.
* New `test/appleChainAdoption.test.js`: A subscribes, A is purged through
  `purgeLocalAccountData`, B restores A's transaction, `getUserSubscription(B)`
  is entitled, `getUserSubscription(A)` is empty.
* New `test/appleNotificationOwnership.test.js`: notification for an adopted
  chain resolves by chain; an unknown chain still resolves by token; an
  unresolvable notification is recorded with `matchedUser: false`.
* **Adoption race with row-level assertions:** two accounts concurrently
  submitting the same released chain produce exactly one adoption, one
  `APPLE_PURCHASE_ACCOUNT_CONFLICT`, and no subscription or transaction rows
  attributed to the loser.
* **Multi-chain refresh:** an account owning two chains has both re-queried by
  `refreshAppleSubscriptionForUser`.

### 9.3 App unit tests

* `resolveEvidenceSubmission` style policy tests: evidence with a foreign
  `appAccountToken` is still submitted; the cap keeps the newest 20 items.
* Error classification: background reconcile with an all-conflict response
  produces no error state; the same response from a user-initiated restore
  produces a message.
* Same classification for the `transaction_update` listener path, which is a
  separate call site with its own error handler.
* The Swift evidence-ordering change cannot be covered by the JS test runner;
  it needs either a native unit test or the manual matrix step 8. Note that a
  native change also requires a new development/TestFlight build, since it
  changes the runtime fingerprint and cannot ship as an OTA update.

### 9.4 Manual verification matrix

Run against a dev build with a fresh sandbox tester, and against TestFlight once
the volume is in place:

1. First purchase, verification, entitlement.
2. Renewal reflected in the entitlement (sandbox renews on a compressed clock).
3. Restore on the same account.
4. Restore on a second live account → 409, no entitlement change, no error
   banner from background reconcile.
5. Delete the owning account, sign in again, restore → adoption, entitlement.
6. Delete the owning account, then re-purchase → succeeds regardless of whether
   Apple reuses the chain identifier.
7. After adoption, re-subscribe with the new account's own token → still
   entitled (the section 5.4 regression, manually).
8. Two-chain account: make the older chain stale, call refresh, confirm both
   chains are re-queried.
9. Redeploy the backend between purchase and restore → state survives
   (acceptance test for the volume fix).
10. Notification handling: a renewal after adoption reaches the new account
    (`matchedUser: true`, matched by chain).

---

## 10. Rollout

1. Backend: owner-aware invariant, single decision point, chain helpers,
   refresh-all, notification ordering, schema comment, tests.
2. App: evidence submission, background error suppression, native evidence
   ordering, restore visibility, messaging, locales, tests.
3. Ops: startup guard, maintenance script, README updates.
4. Railway configuration change.
5. Manual verification matrix.

Optional: gate adoption behind `APPLE_CHAIN_ADOPTION=on` so the release can be
deployed dark, verified with the conflict path unchanged, and enabled
deliberately.

Rollback: reverting the backend commit restores the previous behavior with no
data migration required. If `released_at` was added, the nullable column can
remain in place.

---

## 11. Documentation updates

* Backend `README.md`, section "Verified Apple subscriptions": replace the
  paragraph asserting that no legacy claim path exists and that the ownership
  tombstone survives deletion permanently. Document the four claim rules, the
  provenance (not veto) semantics of the ownership row, and the adoption case.
* Backend `README.md`, "Deployment note": production requires an absolute
  `SQLITE_PATH` on a volume and `BACKEND_REPLICA_COUNT=1`; add the new startup
  guard.
* App `README.md`, "Apple Subscriptions": document restore-after-deletion and the
  multi-chain refresh behavior.
* Privacy policy note: if the ownership row is retained as provenance, the
  existing guidance to disclose the retained binding and its retention period
  still applies.

---

## Open decisions

Resolved by simulation and folded into the sections above: the released-branch
token comparison (dropped, 5.3), the owner-aware invariant (required, 5.4), the
keyed lock (belt-and-braces, 4.1), refresh-all-chains (required, 5.5 item 1).

Still open:

1. Retain `apple_subscription_ownership` rows as provenance once released
   (recommended: no schema change, no deletion hook), or delete them on account
   deletion.
2. Add `released_at` with a schema bump to 3, or leave the schema untouched (the
   claim rules do not require it).
3. Fix test tracking (`test/*` plus negations, or `git add -f`) so the new
   regression tests are committed.
4. Ship adoption behind an `APPLE_CHAIN_ADOPTION` flag, or enable it from the
   first deploy.
5. Whether to keep the keyed lock for observability, given it is not required
   for correctness.

---

## Appendix A: current code references

| Concern | Location |
| --- | --- |
| Claim rules, token gate | `src/subscriptions/appleSubscriptionService.js` — `requireMatchingAccountToken`, `verifyAppleEvidenceForUser`, `fetchAndPersistCurrentStatus` |
| Ownership assertion, persistence | `src/subscriptions/appleSubscriptionStore.js` — `readAppleOwnershipState`, `assertAppleOwnershipState`, `saveVerifiedAppleState`, `getVerifiedAppleSubscription`, `getAppleSubscriptionRefreshTarget` |
| Notification path | `src/subscriptions/appleSubscriptionService.js` — `processAppleNotification` |
| Account deletion | `src/accountDeletion/accountDeletionService.js` — `purgeLocalAccountData` |
| Chain-level serialization helper | `src/utils/keyedLock.js` — `acquireKeyedLock` |
| Table definitions and FKs | `src/db/schema.sql` — `apple_subscriptions` (owner FK cascades), `apple_subscription_ownership` (no FK), `apple_transactions` (owner FK cascades), `apple_notification_events` (owner FK set null) |
| Migrations and schema version | `src/db/initDb.js` — `DATABASE_SCHEMA_VERSION`, `USER_SUBSCRIPTION_COLUMN_MIGRATIONS`, `ACCOUNT_DELETION_COLUMN_MIGRATIONS`, `applyDatabaseSchema` |
| Environment validation | `src/config/runtimeConfig.js`, `src/config/env.js` |
| Apple environment and sandbox switch | `src/subscriptions/appleConfig.js` — `allowedEnvironments`, `getAppleConfigurationSummary`, `createAppleRuntime` |
| Unverified-subscription policy | `src/config/policy.js` — `ALLOW_UNVERIFIED_SUBSCRIPTIONS` |
| Client evidence filtering and error state | `fridge-manager/context/AccountSessionContext.js` — `normalizeAppleEvidence`, `evidenceForAppAccount`, `verifyAppleEvidence`, `restoreApplePurchases`, `reconcileAppleSubscriptionInBackground` |
| Native StoreKit bridge and evidence ordering | `fridge-manager/modules/apple-subscriptions/ios/AppleSubscriptionsModule.swift` — `currentAndUnfinishedEvidence`, `unfinishedEvidence` |

## Appendix B: production findings, 2026-09-29

Captured from the Railway container for `mobilesearcherbackend-production`:

```
NODE_ENV=development
SQLITE_PATH=./data.sqlite
RAILWAY_VOLUME_MOUNT_PATH=          (empty — no volume attached)
APPLE_ALLOWED_ENVIRONMENTS=Production
APPLE_ALLOW_SANDBOX_IN_PRODUCTION=true
```

* `NODE_ENV=development` disables every production guard: the absolute
  `SQLITE_PATH` check, the single-replica check, and the forced-disable of
  `ALLOW_UNVERIFIED_SUBSCRIPTIONS`.
* `APPLE_ALLOW_SANDBOX_IN_PRODUCTION` is inert outside production, so the
  effective allowed environment set is `[Production]` and TestFlight sandbox
  purchases are rejected at signature verification.
* `data.sqlite` (4 KB) with a 1.3 MB `-wal` file: the schema and two user rows
  live in the uncheckpointed WAL. The file was created at container start, so the
  database is recreated on every deploy.
* Table state: `users` = 2 rows (created 2026-09-28 04:00:05 UTC and
  17:22:46 UTC), `account_deletions` = empty, `apple_subscriptions`,
  `apple_transactions`, `apple_notification_events`, and
  `apple_sign_in_credentials` all empty.

Because no ownership or subscription row exists in the live database, the
409 conflict described in section 1 was produced by an earlier container whose
database has since been discarded, and cannot be reproduced against the current
database.

## Appendix C: diagnostic commands

Inspect bindings without deleting anything (run from `/app` inside the container,
since `SQLITE_PATH` may be relative):

```bash
node --input-type=module -e 'import {open} from "sqlite";import sqlite3 from "sqlite3";const db=await open({filename:process.env.SQLITE_PATH,driver:sqlite3.Database});console.log(JSON.stringify(await db.all("select o.environment, o.original_transaction_id, o.app_account_token, o.first_verified_at, (select u.uid from users u where lower(u.app_app_account_token)=lower(o.app_account_token)) as live_owner_uid, (select s.firebase_uid from apple_subscriptions s where s.environment=o.environment and s.original_transaction_id=o.original_transaction_id) as live_subscription_uid from apple_subscription_ownership o"),null,2));await db.close();'
```

Note that copying `data.sqlite` alone while WAL is active yields a stale
snapshot; use `PRAGMA wal_checkpoint(TRUNCATE)` or `VACUUM INTO` for backups.

## Appendix D: simulation scripts

The section 5 simulation was run with three throwaway scripts that live outside
the repository (in the OS temp directory) and import the backend modules by
absolute path, so nothing is committed and nothing in the repositories was
modified:

* `apple-claim-sim.mjs` — the twelve scenarios: first claim, renewal, live-owner
  conflict, deletion, adoption, renewal after adoption, third-account conflict,
  token-changing re-subscribe, notification resolution, adoption race,
  released-token comparison.
* `apple-claim-sim2.mjs` — race side effects with row-level dumps, the
  token-change bug, and a corrected ownership write proving the fix.
* `apple-claim-sim3.mjs` — two chains on one account and the resulting
  `getAppleSubscriptionRefreshTarget` behavior.

They can be re-run with `node <path>` after the backend change lands; the
corrected-write probe in `-sim2` is the reference implementation of the
section 4.1 invariant.
