# Phase 9: Developer feedback loop

Phase 9 extends Phase 8 identities, feedback, and retention. It does not train model
weights, establish that a finding is correct, or automatically change repository
code. The feature is available in History; feedback presentation adaptation is off
by default for each repository.

## Deploy

Back up the database and select the intended deployment environment before running:

```sh
npm exec --workspace=backend -- prisma migrate deploy
npm run prisma:generate
npm run build --workspace=apps/backend
npm run build --workspace=apps/web
```

Migration `20261018000000_developer_feedback_loop` adds independent workflow state,
workflow audit events, rule provenance/revisions/audit, and adaptation settings. It
does not rewrite existing feedback or completed review findings. Deploy the new
frontend and backend together: rule edits/deletes now require `expectedRevision`.

## Finding actions

| Action | Stored meaning |
| --- | --- |
| Helpful | Existing `ACCEPTED` feedback: useful/actionable, not verified or fixed. |
| Not useful | Existing `REJECTED` feedback with a required structured reason. |
| Dismiss | Independent `DISMISSED` worklist state; not a rejection. Restore is supported. |
| Fix | Show/copy unverified remediation; optionally mark `REPORTED_FIXED`. Reopen is supported. |
| Create rule | Prepare an editable, unvalidated model-enforced repository-wide rule. Saving requires explicit confirmation; enabling is a separate deliberate checkbox. |

No fix action executes tests, creates a commit/branch/PR, or verifies a resolution.
Legacy reviews still render. Eligible reviews use the existing explicit identity
backfill; expired/superseded findings cannot be mutated. Workflows default to OPEN
without a bulk backfill. Feedback and workflow have independent revisions.

## Explainable adaptation

The `feedback_v1` policy uses at most 200 recent completed PR reviews and 10,000
current occurrences over 90 days. If the occurrence limit is exceeded, the report
is partial and no adaptation occurs. It does not imply complete repository coverage.

For each case-sensitive fingerprint and PR, the latest recorded feedback wins.
Retries and multiple findings/reviews of a single PR do not add votes. Only current
ACCEPTED/REJECTED assessments count as reviewed; resets and needs-review assessments
remove that PR's previous assessment. Silence is not acceptance. Dismissal and
reported fixes never contribute usefulness votes.

A recommendation requires at least five reviewed PRs, at least three PRs rejected
for the same reason, and a same-reason rejection ratio of at least 80%. Reasons are
reported separately. OTHER produces a manual-review signal without adaptation.
FALSE_POSITIVE recommends contextual checking; INTENDED_BEHAVIOR and
STYLE_PREFERENCE recommend explicit guidelines; DUPLICATE recommends consolidated
presentation; OUT_OF_SCOPE recommends an explicit scope decision. These are
recommendations, not verified detector errors or automatically approved rules.

With explicit opt-in, qualifying LOW/INFO model-only STYLE, MAINTAINABILITY,
ARCHITECTURE, and TESTING advisories are placed behind an expandable History
control. All original findings remain available. Security, correctness/bug findings,
deterministic rules/probes, corroborated findings, and higher-priority reports are
protected. Detection artifacts, severity, risk scores, and GitHub delivery remain
unchanged by presentation adaptation.

Future reviews may receive at most five bounded JSON records (4,000 characters)
as untrusted user context, separate from binding owner rules. Free-text developer
notes, finding summaries, and source excerpts are never sent in this feedback
context. Security fingerprints are excluded. Prompt safeguards prohibit using
feedback alone to suppress security or change severity; model behavior still needs
real-world evaluation.

Snapshots are derived under the Phase 8 repository lock, so no independent stale
counter/cache survives feedback invalidation. Expired and superseded evidence is
excluded. New feedback, contradictions, and expiry recompute recommendations. A
review persists policy version, actually supplied fingerprints, and bounded
finding-key attribution. The detail API validates attribution and expiry and never
uses it to hide protected findings. Old records without attribution are unchanged.

Disable/reset stops adaptation for future reviews without erasing feedback.
Re-enabling recomputes from retained feedback. Stored completed-review attribution
remains historical; it is not silently rewritten when preferences change.

## Rule conversion and concurrency

Draft preparation resolves the exact finding from the stored review server-side;
it performs no persistent rule write and no model call. Rule text is owner-editable.
No code, fixture, or regex is inferred. Finding-derived rules remain model-only even
if edited later. Existing manually configured deterministic rules are unchanged;
their regex execution engine is not hardened by this phase.

Repository-wide scope is explicit. A confirmed enabled rule uses the existing
`RulesService.mergeGuidelines`/worker flow on subsequent reviews. This is advisory
model enforcement, not guaranteed deterministic detection or a merge-protection check.

Creation keys are server-derived and unique within the repository. Concurrent
retries return one rule. A bounded audit tombstone prevents an old request from
recreating a deleted rule. Similar normalized guidelines are rejected with a link
to the rule manager. This detects normalized equality, not arbitrary semantic
equivalence. Repositories are capped at 500 rules.

All rule edits/deletes require the revision read by the client, lock/recheck the
active owning repository, and audit atomically. A stale edit returns 409 rather
than overwriting a newer rule. Finding actions never implicitly change usefulness
feedback or reported resolution.

## API

All routes require authentication and repository ownership.

```text
PUT  /api/jobs/:jobId/findings/:findingId/feedback
PUT  /api/jobs/:jobId/findings/:findingId/workflow
GET  /api/jobs/:jobId/findings/:findingId/workflow/events
POST /api/jobs/:jobId/findings/:findingId/rule-draft
POST /api/jobs/:jobId/findings/:findingId/rule
GET  /api/repositories/:repoId/feedback-insights
PUT  /api/repositories/:repoId/feedback-adaptation
```

Workflow: `{ status, expectedRevision }`, where status is OPEN, DISMISSED, or
REPORTED_FIXED. Adaptation settings: `{ enabled, expectedRevision }`. Initial
revisions are zero. Confirmation: rule fields plus `{ confirmed: true, creationKey }`
from the prepared draft. Missing/invalid input returns 400, unavailable ownership
404, stale/conflicting state 409, and unconfirmed infrastructure failures 503.
After 503, retry with the same creation key or reload to reconcile; drafts remain
in the browser until discarded, navigation, or page reload. They are not persisted.

Mutations and expensive feedback reads have a bounded in-process 60/user/minute
abuse guard. Multi-instance production deployments should additionally enforce a
shared authenticated-user limit at their gateway; this guard is not distributed.

Workflow events cascade with occurrences under Phase 8's 90-day retention.
Source-occurrence provenance is detached on expiry; owner-approved rules remain
until explicitly deleted. Rule/settings audit records are swept in batches of 500
after 90 days. Repository disconnect clears feedback/workflows/audit and disables
adaptation; existing approved rules retain their existing independent lifecycle.
Original review JSON follows its existing separate retention policy.

## Verification and rollout

```sh
npm test --workspace=apps/backend
npm test --workspace=apps/web
npm run build --workspace=apps/backend
npm run build --workspace=apps/web
```

Real PostgreSQL integration tests are opt-in. Apply all migrations to a disposable
local database ending in `_test`; set `DATABASE_URL`, `FEEDBACK_TEST_DATABASE_URL`,
and (for Phase 8 regressions) `HISTORICAL_TEST_DATABASE_URL` to that same URL. Then:

```sh
npm test --workspace=apps/backend -- src/services/feedback-loop/feedback-loop.integration.test.ts src/services/historical/historical.integration.test.ts
```

Tests cover thresholds, reasons, distinct PR support, expiry, protected evidence,
context safety, workflow revisions, tenant isolation, concurrent rule creation and
editing, tombstones, audit rollback, retention, UI confirmation/conflicts, legacy
records, and worker attribution without changing risk.

Start with recommendations visible and adaptation disabled. Opt in a small set of
repositories after manual review. Measure usefulness, repeated rejection reasons,
rule adoption, and missed important findings using authorized reviews. A lower
rejection rate alone is not proof of improved quality. No live GitHub/AI smoke test
or measured quality improvement is implied by passing automated tests.
