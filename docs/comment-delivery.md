# Reliable review comment delivery

Reviews save an encrypted delivery plan before posting. Each inline finding and
optional summary has a durable delivery record and invisible GitHub marker. A
retry resumes that saved review without another AI call or quota reservation.

## Crash recovery

- Unclaimed comments can be sent by the next attempt.
- Confirmed delivered comments are skipped, even if later edited or deleted.
- If the response or receipt write was lost, recovery searches existing GitHub
  comments for the marker, trusted author, and correct destination.
- Uncertain sends remain unconfirmed and are never automatically resent, even
  if a complete listing finds no match. A claim saved immediately before a crash
  may therefore leave a comment unconfirmed that was never sent.
- Definite rate-limit rejections can be retried after backoff. Permanent
  rejections remain visible, and rejected inline findings can appear in the one
  tracked fallback summary when `summarize` is enabled.
- Unconfirmed inline sends never become fallback findings; the summary waits
  for known inline outcomes to avoid publishing the same finding again.
- If final database publication fails after delivery, retries skip GitHub I/O
  and retry publication using the saved artifact.

This favors preventing repeat submissions over guaranteed delivery. It does not
promise unconditional exactly-once delivery across PostgreSQL and GitHub. The
underlying create/list APIs are documented in the official
[review-comment API](https://docs.github.com/en/rest/pulls/comments) and
[issue-comment API](https://docs.github.com/en/rest/issues/comments).

## History and manual checking

History shows delivered, rejected, omitted, pending, and unconfirmed inline
counts, plus summary status. Findings stay readable when delivery fails.
"Check existing GitHub comments" reads GitHub and saves positive evidence. It
never posts, regenerates analysis, restarts a failed job, or infers permission
to resend from a missing match. It remains available after attempts are exhausted.
Legacy jobs show delivery as untracked.

Findings are normalized before a new plan is frozen and hashed, including
scanner `ruleKey` aliases. Completion uses the same normalized representation;
a security FAIL/BLOCK verdict does not mean the review job failed. For eligible
plans saved before this normalization fix, completion verifies the authenticated
frozen findings against the original hash before accepting their normalized
equivalent. Existing plan hashes, comment keys, and receipts are preserved.

The endpoint is `POST /api/jobs/:id/comments/reconcile`, restricted to the owning
user and an active repository, with the existing request rate limiter.

Cancellation stops subsequent sends but cannot retract an already dispatched
request. Late accepted receipts can be recorded without resurrecting a terminal
job. A changed PR head omits unsent old-head comments. Deliberate new manual
reviews and new commits are separate reviews and can produce new comments.

## Limits and lifecycle

- Three BullMQ attempts, with normal exponential backoff extended for GitHub
  rate-limit instructions and outstanding claim expiry. No long worker sleeps.
- Claims expire after 30 seconds and become unconfirmed rather than sendable.
- GitHub requests have 10-second timeouts. Each list scan is bounded to 20 pages
  of 100 comments and 30 seconds; manual checking has a 30-second scan deadline.
  Positive matches from partial listings remain useful.
- Exact payloads and frozen review artifacts use the existing encryption
  service. Public reports exclude payloads, encryption envelopes, and claims.
- Disconnect purges these extra encrypted copies and preserves delivery
  identities/receipts. Maintenance also expires terminal jobs' extra delivery
  copies after 90 days, in batches of 500. Existing `AnalysisJob.results` retain
  their existing lifecycle; this is not retention for all review data.
- Job deletion cascades to plans and receipts. Suppression is scoped to a
  retained job and does not survive deletion of its identity.
- The Octokit REST client does not enable a retry plugin for creation. Do not
  add transparent retries of comment POSTs on transport errors.

Quota notice comments and duplicate suppression across separate reviews are
outside this feature. Existing historical comments are neither edited nor deleted.

## Deployment

1. Stop/drain old workers before cutover and deploy the API and separate review
   worker together. Keep the PostgreSQL and Redis volumes.
2. Apply `20261021000000_comment_delivery` and generate Prisma before starting
   the updated backend. The production image build generates the client and
   startup runs `prisma migrate deploy`.
3. Deploy frontend and backend together. No new production secrets or
   environment variables are required.
4. On a designated test PR, verify posting identity, a normal review, and a
   controlled restart during posting. Existing comment IDs should be reused.

The migration sets existing jobs to `deliveryVersion = 0`; new jobs default to 1.
All unfinished legacy PR jobs, including queued jobs, are skipped with an explicit
untracked-delivery reason. Start a deliberate new review when needed. Completed
legacy jobs are not replayed, and unmarked old comments are not guessed at.

Pause delivery to roll back. Do not restart old untracked workers or drop delivery
tables; mixed versions can bypass tracking. See [DEPLOY.md](../deploy/DEPLOY.md).

## Validation

Unit tests cover worker resume and terminal guards, GitHub receipts and pagination,
trusted posting identity, error classification and backoff, API ownership and
payload privacy, and History reporting/checking.

Local validation passed the full backend suite (1,331 tests, including 31 comment
delivery and 5 context-cache PostgreSQL integration tests; 26 unrelated opt-in
integration tests were skipped), both production builds, and the frontend suite.
The migration chain was applied to a disposable PostgreSQL 15 database. Production
has not been migrated or deployed, and a live GitHub smoke test remains an operator
step.

`comment-delivery.integration.test.ts` uses real PostgreSQL and a fake GitHub server
that remembers accepted comments. It covers lost responses, failed receipt writes,
concurrent and expired claims, summary recovery, transaction rollback, cancellation
races, finalization-only recovery, retention, and cascade deletion. Tests contact
neither GitHub nor an AI provider.

To enable database tests, point `DATABASE_URL` and `DELIVERY_TEST_DATABASE_URL` at
the same disposable local database whose name ends in `_test`, apply migrations
there, then run:

```powershell
npm.cmd test --workspace=apps/backend -- src/services/comment-delivery.integration.test.ts
```

The tests reject remote databases and mismatched URLs. Never use a shared or
production database. See the [implementation plan](comment-delivery-idempotency-plan.md).
