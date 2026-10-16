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

## Remaining confirmed issues

- 27: entitlement and overview select the most recently updated subscription;
  cancellation skips recalculation if another subscription exists.
- 28: reservations use separate installation/user ledgers and do not restrict
  Free customers to one private repository.
- 29: checkout creation has no repeated-request or existing-subscription guard.
- 30: repository removal filters only by GitHub repository ID, across installations.
