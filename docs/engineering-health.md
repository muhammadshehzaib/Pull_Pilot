# Phase 10: Engineering Health

The authenticated `/dashboard` combines persistent engineering-health analytics with the existing Socket.IO live activity feed and usage meter. It operates on the signed-in owner's active repositories, not on an invented organization/team membership model.

## Metric contract (engineering_health_v1)

Reporting uses trailing 7, 30, or 90 days, UTC, with a half-open interval `[start, end)`. Comparison uses the immediately preceding equal-length period. Weekly buckets start Monday UTC; first and last buckets can be partial.

| Card | Meaning |
| --- | --- |
| Repositories | Currently connected active repositories in the selected scope, independent of the review date window. |
| PRs reviewed | Distinct repository/PR pairs with precisely dated completed review artifacts in the period. Latest completed artifact per PR wins; retries, regenerated artifacts, and repeated reviews are not extra PRs. Push, failed, canceled, timed-out, skipped, and in-flight jobs do not count. |
| Critical findings detected | Unique critical findings in those selected artifacts. This is not a count of currently open issues. |
| Developer-reported fixes | Distinct finding workflows on the selected artifacts whose latest event before period end is REPORTED_FIXED, recorded inside the period. Undo/reopen removes the count. Superseded snapshot feedback is not transferred to new findings. Helpful/accepted feedback is not a fix. This is self-reported, not independently verified prevention. |
| Suggested test gaps | Unique advisory scenarios in selected artifacts with an actual analyzed test-gap report. These are not executed tests or measured coverage. Unanalyzed records are excluded; the analyzed-PR denominator is disclosed. |
| Security findings detected | Unique findings classified SECURITY or carrying SAST/SECRETS/DEPENDENCIES provenance. Detectors do not produce multiple counts for the same normalized issue/location. |
| Average indicated PR risk | Arithmetic mean of compatible completion-time risk_v2.1 scores (0 lower, 100 higher), with the scored/captured PR denominator shown. Missing, unversioned, or incompatible scores are excluded, not converted to zero. |

Finding deduplication uses normalized issue text, path and line, with strongest severity retained and security provenance unioned. It is exact normalization, not speculative semantic equivalence. Case-sensitive paths remain distinct. Only finding counts/coverage/configuration hashes are copied into analytics; no issue descriptions, source excerpts, notes, drafts, screenshots, or secrets are copied.

Trend buckets independently select the latest artifact per PR **within each bucket**. A PR can appear in several buckets. Do not sum bucket counts to derive the period PR count. Missing scores produce gaps, not zero-risk points, and the accessible table exposes every bucket's denominator.

## Evidence and comparison policy

The API exposes captured, scored, analyzed-for-test-gaps, partial-evidence, approximate-date and legacy-without-completion counts separately. Captured counts can be a partial subset of historical reviews. When only unknown/approximate data exists, precise totals are unavailable rather than fabricated zeros. A zero score does not prove safe code, successful CI, or complete scans.

A percentage comparison requires:

- Tracking to cover both full periods.
- At least 10 compatible scored PRs in each period and no unscored selected artifacts.
- The same repository cohort and per-repository configuration/scan-coverage profile sets.
- Matching versioned risk algorithm, configuration hash (repository settings, provider/model configuration and rule revisions), and evidence profile.
- A nonzero previous mean.
- No unbackfilled legacy reviews with unknown completion dates that could make the sample incomplete.

Otherwise the UI gives a reason for insufficient/incompatible evidence. The approved wording is “Average indicated PR risk decreased/increased by X%.” This does **not** measure overall code quality or establish a causal effect of this product. Even eligible comparisons do not control for PR complexity or changing repository/profile mixture weights.

The risk engine and completion publisher are deliberately separate from the job-detail API, which may recompute risk using later behavioral results. Later CI/evidence updates do not rewrite a stored completion-time score. Bump `RISK_ALGORITHM_VERSION` when scoring semantics change, and the pipeline version when review-generation semantics change, before claiming comparable trends.

## Persistence, retention, and access

Review completion, finding identities, and an immutable `ReviewAnalyticsFact` revision commit in one repository-locked transaction. Identical publication retries do not append facts; changed numeric snapshots/findings generate a new revision. Reads choose the latest artifact in the requested period/as-of boundary. Backfill and worker publication use the same lock. Numeric facts have explicit 180-day retention to support a 90-day current and 90-day comparison window. A bounded sweep deletes at most 500 expired rows per minute and queries exclude expired facts even before the sweep catches up.

This does not extend the existing 90-day raw occurrence/feedback/workflow retention. If fix evidence is expired or incomplete, the fix metric becomes unavailable; analytics do not secretly retain raw feedback for longer. Disconnect clears facts with historical state and resets the tracking start; repository/account/job deletion cascades to its facts. Original legacy review JSON and old history rendering are preserved.

All four endpoints require authentication and scope every database read to the authenticated owner and active repository. Foreign/disconnected IDs return 404. Responses are `private, no-store`; storage failures return a sanitized 503, never zero totals. Filters, page size, scan size, output and transaction time are bounded. The existing per-process 60/user/minute guard is shared with feedback endpoints; multi-instance deployments should also enforce a gateway limit.

## API

```text
GET /api/dashboard/engineering-health
GET /api/dashboard/risk-trend
GET /api/dashboard/repositories
GET /api/dashboard/reviews
```

Shared query fields: `range=7d|30d|90d`, `bucket=day|week`, optional `repositoryId`, optional ISO `asOf`, `page=1..1000`, `limit=1..50` (default 10). Reviews accept `metric=all|critical|security|testGaps|risk|reportedFixes`. All drilldowns use the same representative-artifact policy, scope and coverage metadata. Fix drilldowns show supporting reviews, not one row per fixed finding.

The UI passes the summary's `scope.end` as `asOf` to paged drilldowns so newly completed reviews or later workflow events do not silently enter the previous snapshot. As-of requests expire after 24 hours; refresh to renew. Retention/deletion can still remove records, so as-of reads are not archival exports. A completion event triggers a debounced fresh server query, not client-side counter increments. Request cancellation prevents stale filter responses from replacing newer data.

## Deployment and explicit legacy backfill

Deploy the additive migration before starting the new backend API/worker, then deploy the web app:

```powershell
npm.cmd run prisma:generate
npm.cmd exec --workspace=backend -- prisma migrate deploy --schema prisma/schema.prisma
npm.cmd run build --workspace=backend
npm.cmd run build --workspace=web
```

Migration `20261019000000_engineering_health` adds nullable `completedAt`, revision/hash fields and the numeric facts table. Existing repositories receive an `analyticsStartedAt` equal to migration time; existing job completion dates are **not** invented. New completed reviews are captured automatically. Prior legacy reviews still render in history.

Optional operator-only backfill (build first, explicitly select the intended database through the existing backend environment):

```powershell
# One bounded, read-only dry run; default is 100 records.
node apps/backend/dist/scripts/backfill-analytics.js --batch-size=100
# Explicit application, then repeat with the returned cursor until nextCursor is null.
node apps/backend/dist/scripts/backfill-analytics.js --apply --batch-size=100
node apps/backend/dist/scripts/backfill-analytics.js --apply --batch-size=100 --after=RETURNED_CURSOR
```

Backfill only considers active-repository completed records created within the 180-day numeric retention window and without a prior analytics revision. It stores `APPROXIMATE_CREATED_AT` facts using the original creation date, never updates `completedAt`, never runs repository code, and never claims those are precisely dated completions. Approximate records remain excluded from precise cards and percentage comparisons. Dry-run and apply return only counts/cursors; no review content is logged. Legacy reviews without snapshots are disclosed as unknown-date records, not silently treated as absent evidence. Backfill does not reconstruct expired workflow events.

## Current limits

- At most 10,000 fact revisions are read across both periods. Above that cap, totals/trends are unavailable and the UI asks for a narrower scope. This is fail-closed bounding, not a claim of warehouse-scale analytics.
- Workflow evidence is bounded to 50,000 events; overflow makes the fix count unavailable.
- Repository picker/breakdown show at most 500 active repositories and disclose truncation. The repository card still counts all active repositories in scope. Page sizes are capped at 50.
- There is no organization-wide sharing, retention override, verified prevention/coverage metric, export, or comparison adjusted for PR complexity. No extra LLM calls or untrusted execution are added.
- Production database migration, optional legacy backfill, and browser acceptance against a live deployment are operator steps; local test runs do not perform them.

## Verification

```powershell
npm.cmd test --workspace=backend
npm.cmd test --workspace=web
npm.cmd run build --workspace=backend
npm.cmd run build --workspace=web
```

The opt-in PostgreSQL suite additionally requires `ANALYTICS_TEST_DATABASE_URL` and `DATABASE_URL` to select the same explicitly disposable localhost `*_test` database, with migrations already applied:

```powershell
npm.cmd test --workspace=backend -- src/services/analytics/analytics.integration.test.ts
```

Coverage includes metric normalization, strongest-severity deduplication, missing/legacy evidence, UTC boundaries, bucket gaps, comparison guards, tenant authorization, read limits, rollback/idempotency/regeneration, frozen risk, workflow undo/as-of state, dry-run/resumable backfill, retention/cascade/disconnect, sanitized HTTP failures, UI loading/error/filter races, drilldown snapshot scope, accessible charts, and preservation of live activity/usage/history.

Schema comparison after applying all migrations reports an existing historical-pattern index-name mismatch (the Phase 8 migration uses a PostgreSQL-truncated identifier). Phase 10 schema objects match. The unrelated index rename was deliberately not included in this change.
