# Phase 8: Historical intelligence

Historical intelligence records explicit feedback, groups recurring repository issues,
and optionally supplies bounded historical context to future reviews. It retrieves
historical evidence at inference time; it does not train model weights or establish
that review accuracy has improved.

## Deployment

Deploy migration `20261017000000_historical_integrity` and regenerate Prisma before
starting the updated backend:

```sh
npm exec --workspace=backend -- prisma migrate deploy
npm run prisma:generate
```

The migration adds durable snapshot and aggregation watermarks, an exact finding key,
aggregate expiry, and a deletion-invalidation trigger. It deletes only rebuildable
historical aggregates, not review results or developer feedback. The maintenance
worker rebuilds aggregates from retained occurrences, reconstructing case-sensitive
v2 fingerprints from original file paths. No migration is applied automatically on
application startup.

## Developer flow

1. Open a completed review in History.
2. Accept, reject with a structured reason, request further review, or reset feedback.
3. Notes have an explicit Save action. Failed requests preserve entered text.
4. Open **Historical insights** to inspect patterns or explicitly enable memory.
5. For older eligible reviews, **Enable feedback for this review** performs an
   authenticated, explicit backfill. Reading history never backfills occurrences.

Memory is off by default. Recording feedback identities is independent of this
setting; disabling memory stops supplying history to new reviews, not collecting
review identities or erasing feedback. Disconnecting a repository erases its Phase 8
occurrences, feedback, audit events, and aggregates, and disables memory. Existing
review-history results follow their existing separate lifecycle.

Accepted means useful/actionable, not verified, fixed, or tested. Silence is
unreviewed. Rejections distinguish false positives, duplicates, intended behavior,
out-of-scope findings, style preferences, and other reasons. Only explicit
`FALSE_POSITIVE` feedback contributes to that reported count.

## Identity and concurrency

Each job has a durable snapshot revision and a content hash. Reordering or retrying
the same normalized artifact preserves occurrence IDs. Different generated results
advance the revision, supersede old occurrences, and create new IDs. Empty snapshots
also supersede old findings. Final review results, snapshot identity, occurrences,
and aggregation invalidation commit in one transaction.

An exact `findingKey` includes the finding text, remediation, path, location,
severity, category, and provenance. The detail API attaches feedback by this key,
not by array position or approximate file/line matching. Cross-review fingerprints
are separate, versioned keys and preserve repository path case.

Feedback requires `expectedRevision`, including `0` for initial creation. Successful
creation returns revision `1`. Writes lock the owning repository, recheck ownership
and supersession, use a revision-qualified update, append an audit event, and
invalidate aggregates transactionally. Conflicting changes return `409`; an
immediate retry of the same intent is a no-op. Audit responses return the newest
100 events.

## Aggregation and bounded execution

- At most 200 completed jobs in a 90-day window contribute to a rebuild.
- Distinct PR support counts PR references, not worker retries or number of findings.
- Push findings do not add PR support. Memory requires at least three distinct PRs.
- Repository mutations increment a durable history revision and invalidate old
  aggregates immediately. Rebuilds serialize with those mutations and publish their
  watermark in the same transaction.
- A maintenance pass runs at startup and every minute. It removes at most 500 expired
  occurrences and attempts at most 10 due repository rebuilds per pass. Failed work
  remains pending in database watermarks for a later retry.
- Each rebuild has a 30-second transaction timeout. Review memory failure is
  best-effort: the review proceeds without historical context.
- Job deletion cascades remove raw feedback; a database trigger invalidates derived
  patterns as well. Repository deletion cascades remove all Phase 8 records.

The 90-day policy applies to Phase 8 copies and feedback associated with a review,
not to deletion of the original completed review JSON. Expired reviews cannot be
backfilled. Their findings remain readable, with feedback unavailable.

## Memory boundaries

Retrieval refreshes dirty or hour-old aggregates. It excludes inactive repositories,
disabled memory, expired contributions, and patterns below the recurring threshold.
An aggregate expires when its earliest contributing job/occurrence reaches the
window boundary, so expired support is excluded even before cleanup runs. If a
historical date barrier is requested, both observation and aggregation timestamps
must precede it; unavailable historical snapshots are not fabricated.

At most five patterns and 4,000 serialized characters are supplied. Fields are JSON
encoded and explicitly framed as untrusted data, separately from binding owner
rules. Free-text feedback notes are never supplied. This reduces instruction-channel
confusion; it is not a guarantee that an LLM is immune to prompt injection.

All new findings still require current-code evidence. Historical feedback does not
disable deterministic checks, change repository rules, lower risk scores, or mark
anything verified. The UI reports context supplied, not independent verification.
Attribution includes only actually serialized pattern IDs, the algorithm version,
and whether some patterns were omitted to fit the limit.

## API

All endpoints require authentication and repository ownership.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/jobs/:id/findings` | Current occurrences and feedback |
| PUT | `/api/jobs/:id/findings/:findingId/feedback` | Feedback with required expected revision |
| GET | `/api/jobs/:id/findings/:findingId/feedback/events` | Bounded audit trail |
| POST | `/api/jobs/:id/findings/backfill` | Explicit eligible legacy backfill |
| GET/PATCH | `/api/repositories/:id/historical-intelligence/settings` | Opt-in setting; PATCH body `{ "enabled": true }` |
| GET | `/api/repositories/:id/historical-insights` | Patterns, metrics, and freshness |

## Verification

```sh
npm run test --workspace=backend
npm run test --workspace=web
npm run build --workspace=backend
npm run build --workspace=web
```

PostgreSQL integration tests are opt-in. Apply migrations to a disposable local
database whose name ends in `_test`, then set both `DATABASE_URL` and
`HISTORICAL_TEST_DATABASE_URL` to that same URL before running:

```sh
npm run test --workspace=backend -- src/services/historical/historical.integration.test.ts
```

The suite rejects non-local or non-test destinations and creates/removes only its
own fixture owner. It tests rollback, snapshot retries, concurrent feedback,
tenant isolation, invalidation, legacy fingerprint conversion, retention, and
disconnect cleanup. Ordinary unit tests do not load this database client when the
integration suite is disabled.

Before claiming better review quality, evaluate with human-adjudicated examples,
chronological holdouts, and a no-memory baseline. Measure correctness, important-defect
recall, unsupported findings, latency, and cost; acceptance rate is not accuracy.
