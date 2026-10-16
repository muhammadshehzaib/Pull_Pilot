# Billing and installation fixes

Code audit confirmed issues 24, 26, 27, 28, 29, and 30 on the starting revision
`d92ddcc`. Fixes are committed and pushed individually in that order.

## 24 — Paid access on installation linking

Evidence: the installation webhook creates a Free installation; the setup
callback assigned its owner without synchronizing the owner's paid entitlement.

Plan: synchronize entitlement in the same transaction that links the installation,
including any additional organization installations. Keep unowned installations
Free until their ownership is verified.

Implemented: the authenticated installation claim now calls the entitlement
service with its transaction. Regression coverage checks Team, Indie, and Free
customers. Validation: 50 billing/auth tests passed; backend TypeScript build passed.

## 26 — Ordered billing events

Plan: retain Polar's signed event timestamp per subscription, serialize account
updates with a user row lock, and commit subscription state and entitlement
together. Persist revocations even if the creation delivery has not arrived.

Implemented: older and duplicate events are ignored; revocation wins timestamp
ties. Installation linking takes the same account lock. Scheduled cancellation
uses the supplied subscription status rather than forcing early revocation,
per https://polar.sh/docs/api-reference/webhooks/subscription.canceled.
Immediate revocation also recalculates remaining entitlement atomically.

Validation: 72 billing/controller/auth tests passed, including both out-of-order
directions, duplicate events, equal timestamps, and revocation before creation.
Backend build passed. The `20261023000000_billing_event_order` migration must be
applied before deploying the code. No live database was modified.

## 27 — Highest active paid plan

Plan: centralize selection of recognized, entitling subscriptions and rank Team
above Indie, independent of recency. Use it for installation entitlements,
billing overview, and directly connected repository quota reservations.

Implemented: the shared selector excludes unknown/Free products and inactive
subscriptions. Revocation recalculates entitlement (introduced with the atomic
event processing in 26), so Team correctly falls back to an active Indie plan.
Validation: 102 billing/auth/quota/recovery tests passed, including Team-to-Indie
fallback and an unknown product alongside a paid subscription; backend build passed.

## 28 — Account quota and one private repository

Plan: serialize reservations by account, sum all connection usage, charge an
account/month ledger, and enforce one eligible private repository for Free.
Preserve old usage and refund receipts when migrating installation ledgers.

Implemented: all producers use account reservations. The earliest connected
active private GitHub repository is eligible on Free; other private repositories
require disconnecting the eligible repository or upgrading. Public and paid
reviews remain unlimited. Old installation counters are merged into account
ledgers and review receipts are retargeted in a locked migration transaction.
New account usage survives installation removal. Unused per-installation charging
helpers were removed.

Validation: 141 relevant tests passed, including concurrent last-slot reservations
across direct and installation connections, private repository eligibility,
disconnection, paid/public access, and refunds. Both migration scripts were also
executed against a disposable PGlite PostgreSQL engine; totals, account isolation,
receipt remapping, original-month refunds, installation deletion, and enum plan
ordering passed. Backend build passed. Full multi-connection PostgreSQL integration
coverage is included but needs `RECOVERY_TEST_DATABASE_URL`; Docker is unavailable
in this session.

Deployment: apply `20261024000000_account_review_quota` with old API/worker producers
stopped, before starting the new code, so old writers cannot recreate installation
ledgers after consolidation. No live database was modified.

## 29 — One checkout per account

Plan: serialize checkout creation with the account row lock, persist the exposed
checkout, reuse an open session, and refuse a second purchase while a subscription
or payment is active. Check Polar as well as local state to cover webhook delays.

Implemented: concurrent requests reuse one checkout across API instances. A
different plan cannot open another session while the first is open. Processing
payments and paid subscriptions return HTTP 409 with a useful message shown by
the Upgrade button. Expired/failed sessions can be replaced. A completed checkout
allows repurchase only after Polar confirms its subscription ended. Provider
failures block a new purchase rather than guessing that no subscription exists.

Validation: billing/auth/controller regression tests, backend build, web typecheck,
and the UpgradeButton lint check passed. The checkout migration was executed in a
disposable PostgreSQL engine; uniqueness and deletion cascade passed. PostgreSQL
integration tests cover real account locks and concurrent checkout reuse when
`RECOVERY_TEST_DATABASE_URL` is configured.

Deployment: apply `20261025000000_checkout_guard` before starting the new code.
The Polar access token needs subscription read access as well as checkout access.

## 30 — Installation-scoped repository removal

Plan: scope both deactivation and the list used for cancellation/cache cleanup to
the installation identified by the signed GitHub event.

Implemented: removal now matches both GitHub repository ID and installation ID.
Other installation connections and direct connections stay active; their reviews
and cached code are not touched. Validation: 82 webhook/recovery/body integration
tests passed, including a shared-repository scenario across three accounts, and
the backend build passed.

## Final validation

- Full backend suite: 2,014 tests passed; 79 environment-gated tests skipped.
- Full web suite: 215 tests passed.
- Backend TypeScript build, web typecheck, changed frontend component lint, and
  whitespace checks passed.
- All three new SQL migrations passed the disposable PostgreSQL-engine checks
  described above. Live multi-connection PostgreSQL tests remain environment-gated.
- Deployment still requires the three migrations and the producer-stop sequence
  documented under issue 28. Pushing source code did not migrate a live database.
