# Abandoned review recovery and quota refunds

## Confirmed gaps and plan

BullMQ can fail a repeatedly stalled job without running the processor's catch
block. Repository disconnects do not terminalize reviews, and no startup sweep
reconciles queue state with database state. Usage increments have no per-review
receipt, so an exact refund cannot currently be proved.

1. Add queue linkage and per-review quota receipt fields. Reserve usage and
   save its exact ledger/counter atomically under the review lock. Use the
   database review ID as the BullMQ job ID on all three enqueue paths.
2. Atomically close unsuccessful reviews and refund a tracked charge once, to
   its original ledger/month. Completed reviews stay charged; retries retain
   their reservation. Never guess refunds for historical untracked charges.
3. Cancel disconnected reviews promptly and reconcile remaining work in bounded
   startup/periodic sweeps. Handle queue failures independently of processor
   catch blocks. Preserve waiting/delayed work, recheck stale snapshots under
   lock, and use worker heartbeats to distinguish active from abandoned work.
4. Test disconnects, repeated stalls, missing queue entries, startup recovery,
   completion races, month boundaries, tenant ownership, refund idempotence,
   Redis outages, and legacy queue IDs. Run regressions/build and push master.

## Operational contract

Recovery never reposts comments, regenerates a review, or refunds COMPLETED
reviews. Failures/cancellation/timeouts/skips return a provable reserved slot;
transient retries do not. Existing comments/receipts and findings are preserved.
Historic usage was not recorded per review, so old refunds need an operator
audit; decrementing an inferred customer's monthly total is unsafe.

Deploy the additive migration before starting updated API/worker processes.
Drain old producers/workers during cutover. Recovery requires an available
database and, for queue reconciliation, Redis; it retries later on outages.

## References

- https://docs.bullmq.io/guide/jobs/stalled
- https://docs.bullmq.io/guide/jobs/job-ids

## Verification

- Full backend suite: **1,596 passed, 70 skipped**. Production TypeScript build,
  Prisma client generation, and `git diff --check` passed. Changes reviewed.
- 36 service-level recovery/quota tests exercise the real recovery, quota, and
  lifecycle services with a serialized in-memory transaction substitute and
  fake queue. They cover disconnects, queue exhaustion, missing entries before
  and after charging, startup failures/retry, no overlapping cycles, hung Redis
  reads, live heartbeats, new retry startup, completed/heartbeat races, legacy
  IDs/truncated listings, tenant identity, concurrent reservations/refunds,
  original-month counters, free-tier limits, and rollback failures.
- Controller/producer regressions verify stable queue IDs and that internal
  quota/queue fields stay out of public job details. The worker entry regression
  now asserts inactive repositories persist CANCELLED rather than remain POSTING.
- Five opt-in PostgreSQL tests were added for concurrent reservation/refund,
  original-month refund, completed-state guards, pre-enqueue crash recovery,
  and transaction rollback. They were skipped along with the other DB tests:
  no disposable database is configured and the local Docker engine is unavailable.
  No real process-crash/Redis recovery smoke test or production deployment was
  performed. Unit tests model queue failures; they do not simulate a live crash.

## Runtime limits and deployment

- Recovery runs immediately on worker startup and every 60 seconds without
  overlapping cycles. Each pass checks at most 100 reviews using an ID cursor.
  Remaining batches are checked in later passes; this is not a capacity benchmark.
- Queue exhaustion/disconnects do not wait for age expiry. Missing jobs and
  active jobs without progress get the configured review timeout plus two
  minutes of grace (12 minutes with the default 10-minute review timeout).
  Active queue retries get the same grace from their actual start time.
- Workers report progress every 30 seconds. Waiting, delayed, paused,
  prioritized and waiting-for-children jobs are preserved. Redis read failures
  and three-second read timeouts never count as proof that a job is missing.
- New jobs default to stable-ID queue version 1, including crashes before
  reservation. Existing jobs migrate to version 0. Legacy numeric IDs are
  adopted when found in a bounded queue listing. A missing legacy job is only
  settled when the listing is demonstrably complete. Large/ambiguous legacy
  listings remain conservative and may need an operator audit or a drained queue.
- Apply `20261022010000_review_recovery` after draining old producers/workers,
  then redeploy API and worker together. Keep existing PostgreSQL and Redis
  volumes. Do not run old numeric-ID producers after this migration; they do
  not write the new linkage/receipt contract.
- To run the optional database tests, apply migrations to a disposable local
  database whose name ends in `_test`, set `DATABASE_URL` and
  `RECOVERY_TEST_DATABASE_URL` to that same database, then run
  `npm test --workspace=apps/backend -- src/workers/review-recovery.integration.test.ts`.
- After deployment, smoke-test a disconnected review, a controlled repeated
  worker crash, and a restart between reservation and enqueue. Verify terminal
  database status, original ledger count, and no duplicate refund after another
  recovery pass. Previously posted GitHub comments are not deleted or reposted.
