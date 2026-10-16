# Review delivery and development polling

## Audit and plan

1. Test-file replacement is already blocked: the draft controller and publication
   service refuse GitHub writes, even with confirmation. Skip this finding.
2. Comment delivery saves findings before posting and avoids uncertain resends,
   but UNKNOWN posts still prevent completion, rate limits consume the three
   processing attempts, and failed-job cleanup cascades into delivery receipts.
   Allow completion with explicitly unconfirmed delivery, post a count-only
   warning in the summary without duplicating uncertain findings, and delay
   definitely rejected posts without consuming processing attempts or calling AI.
   Bound delivery to three definite rate-limit rejections per comment and a
   24-hour delivery window. Keep tracked failed jobs out of automatic deletion.
3. Polling is enabled by default, includes App installations that receive App
   webhooks, and stores one permanent Redis key per PR revision. Make it opt-in,
   exclude App installations, validate a minimum one-minute interval, and use an
   expiring per-PR latest-head cache. Migrate old permanent keys in bounded SCAN
   batches by assigning expiry. Database review identities still prevent repeats
   after cache expiry.
4. Cancellation already calls queue.remove(id); current producers use the job ID
   as their BullMQ ID and the worker checks CANCELLED. Skip this finding.

## Verification and delivery

Add regressions for partial completion with retained findings, an independent
summary, uncertain-post non-resubmission, safe delayed retries and limits,
retention guards, polling defaults/filtering and cache expiry. Run focused tests,
the full backend suite, production compilation, and inspect the diff. Push the
comment fix and polling fix separately to master.

## Limits and rollout

An uncertain comment may have reached GitHub: it is never blindly resent and its
finding is kept in the app. GitHub-wide downtime can prevent a summary too; its
delivery status stays visible. A deliberate new review or changed commit can
produce new comments. Explicit repository/job deletion still deletes receipts;
automatic failed-job cleanup no longer does so for tracked reviews. Existing
already-deleted receipts cannot be recovered. Extra encrypted delivery payloads
still expire through existing maintenance.

Deploy the API and worker together. No database migration is needed. Existing
REPO_POLL_ENABLED=true explicitly keeps polling enabled; production should set
it to false. Polling is only a local-development fallback for non-App repositories.
Real PostgreSQL/Redis integration tests require their opt-in test services;
mocked tests alone do not prove production delivery or capacity.
