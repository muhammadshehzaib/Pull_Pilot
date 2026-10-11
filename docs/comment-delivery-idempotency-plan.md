# Plan: resume review comment delivery without posting duplicates

Status: implemented for the conservative first release described below. See
[comment-delivery.md](comment-delivery.md) for shipped behavior, limits, recovery,
retention, deployment, and validation. Production deployment and a designated
live GitHub smoke test remain operator steps.

## Goal

If a worker crashes after posting some review comments, its next attempt should
continue the same saved review, recognize comments already on GitHub, and send
only comments that are safe to send. Cover inline findings and the top-level
review summary, including its fallback findings section.

In simple words: save a checklist before posting, give each comment a unique
label, and check both the checklist and GitHub when recovering from a crash.

Example: a review contains five findings. The worker posts two, then crashes.
The next attempt recognizes those two and continues with the remaining three;
it does not ask the AI to create another review.

## What the repository does today

- `AnalysisJob` has a unique review identity for webhook/poller jobs:
  repository, event type, reference, and commit SHA. This prevents duplicate
  review rows, but does not record delivery of individual comments.
- `analysis.worker.ts` saves findings, then loops through
  `createReviewComment`, optionally calls `createIssueComment`, and finally
  calls `recordJobFindings` to publish completion and historical occurrences.
- `GitHubService` currently returns only `ok` and an error string from comment
  creation. It discards successful GitHub comment IDs and treats all errors alike.
- `config/queue.ts` allows three attempts. Attempts restart the pipeline,
  including AI generation. The worker's transient failure path replaces
  `results` with an error object, potentially losing the findings it just saved.
- `advanceReview` refuses terminal state transitions, but returning from that
  helper does not itself stop the worker from continuing. Entry guards and
  conditional completion need to enforce this explicitly.
- Manual reviews intentionally create a new job with `commitSha: null`.
  Retrying that job must reuse its delivery records; a deliberate new review
  remains a separate review.

Saving `COMPLETED` earlier or setting a boolean before posting would trade
duplicates for silently missing comments. It would not close the crash window.

## Delivery contract and limits

Use PostgreSQL for durable delivery records and GitHub comment bodies for
recovery markers. Reuse BullMQ for attempts; a separate sending queue is not
needed for the first release.

GitHub documents separate create/list endpoints for inline review comments and
issue comments, with IDs, bodies, and authors in responses. We can use these to
reconcile delivery. See the official [review-comment API](https://docs.github.com/en/rest/pulls/comments)
and [issue-comment API](https://docs.github.com/en/rest/issues/comments).

The documented create operations do not expose a caller-supplied idempotency
key. The design therefore treats a lost response as ambiguous; this is an
engineering inference from those API contracts, not a GitHub exactly-once guarantee.

The first release prioritizes avoiding repeat submissions over automatically
delivering every uncertain comment:

- A confirmed delivered comment is never automatically recreated.
- A request known to have been rejected may be retried when appropriate.
- A request that might have succeeded is reconciled by reading GitHub. If it
  cannot be confirmed, it stays unconfirmed and is not automatically resent.
- Even a complete listing with no match does not prove that an earlier request
  will never finish or that its comment was not subsequently deleted.

This protects ordinary crash/retry cases without promising unconditional
exactly-once delivery across two independent systems. A crash immediately
before the actual HTTP request can also leave a comment unconfirmed; accepting
that limitation is necessary for the conservative policy.

Scope is delivery within one retained `AnalysisJob`. New commits and deliberate
new manual reviews can produce new comments. Cross-review suppression, quota
notice comments in `webhook.controller.ts`, deleting old duplicates, and edits
to existing GitHub comments are separate work.

## 1. Freeze the review before any comment is sent

Introduce a `prepareReviewDelivery` service. In a short database transaction:

1. Lock the repository and job in a consistent order and verify ownership,
   active repository, and an eligible nonterminal job state.
2. Save the complete reviewed artifact: normalized findings, reviewed head/base
   SHAs, configuration, checks, risk reports, context discovery, test gaps,
   behavioral metadata, and attribution required for historical/analytics
   completion. Capture these from this attempt rather than rebuilding them
   from newer settings on a retry.
3. Create an immutable delivery plan and its inline delivery rows. Prepare one
   summary slot when `summarize` is enabled; its final body will depend on
   confirmed inline outcomes.
4. Move the job to `POSTING` and commit before allowing any GitHub write.

The saved plan is authoritative. If a concurrent worker has already prepared
one, load that plan instead of replacing it. Use existing `findingIdentity`
and `snapshotIdentity` helpers to identify the exact frozen findings; do not
use a fuzzy historical fingerprint or array position as delivery identity.

Persist the exact rendered inline body and its digest. A renderer upgrade,
changed AI wording, or reordered findings must not change an existing plan.
Deduplicate identical finding identities before creating rows.

## 2. Add a durable plan and one record per comment

Add an additive Prisma migration for these proposed models:

| Record | Important fields and constraints |
| --- | --- |
| `ReviewDeliveryPlan` | Unique `analysisJobId`, version, artifact hash, exact head/base SHAs, repository identity, PR number, expected GitHub author ID, frozen completion artifact, preparation timestamp |
| `CommentDelivery` | Plan ID, stable delivery key, kind (`INLINE` or `SUMMARY`), finding key if applicable, destination path/line/head for inline comments, exact payload and digest, state, attempt count, next attempt time, claim token/expiry, GitHub comment ID/URL, bounded error classification, timestamps |

Use `@@unique([planId, deliveryKey])`. Use separate uniqueness for a received
GitHub comment ID within its repository and comment kind, allowing null before
confirmation. Store external numeric IDs as strings or database `BigInt`,
with explicit JSON conversion.

Suggested keys are versioned `inline:<findingIdentity>` and `summary` within
the unique job plan. The marker carries an opaque delivery UUID; no source
code, credentials, user IDs, or finding text belong in it.

Encrypt the frozen artifact and comment payloads with the existing
`EncryptionService`. Keep only routing/status data and payload digests outside
the encrypted envelope. Add cascading relations from job to plan to deliveries.
Do not serialize encrypted payloads, claim tokens, or raw provider responses
into public API responses or logs.

## 3. Define delivery states precisely

| State | Meaning | Allowed automatic action |
| --- | --- | --- |
| `WAITING` | Summary body cannot yet be finalized | Wait for inline outcomes |
| `READY` | No possibly successful request is outstanding | Atomically claim and send |
| `SENDING` | Durable claim saved before the HTTP request | Only the claim owner may initiate that request |
| `DELIVERED` | Successful response or matching GitHub comment confirmed | Skip |
| `REJECTED` | Definitive permanent rejection, such as a validated invalid diff location | Surface failure; include in fallback when enabled |
| `UNKNOWN` | Request may have succeeded; response or receipt persistence was lost | Read-only reconciliation; never blind resend |
| `OMITTED` | Deliberately skipped, such as a stale PR head before any send | Surface reason; skip |

Transient failures with a definite rejection may return to `READY` with a
backoff time. A timeout, connection reset after dispatch, uncertain server
error, or crash while `SENDING` moves to `UNKNOWN`. Unknown failures must not
be classified as invalid diff lines or converted into a fallback duplicate.

## 4. Give each posted comment a recovery marker

Append a versioned HTML comment to the saved payload, for example:

```html
<!-- aipr-delivery:v1:opaque-delivery-uuid -->
```

For each installation or PAT mode, resolve and save the expected posting
actor's trusted numeric GitHub ID before preparing a sendable plan. If that
identity cannot be established, stop delivery rather than accept any matching
comment as proof.

Reconciliation must match the marker, trusted author, repository, PR, comment
kind, and inline original commit/path where applicable. Request raw Markdown
bodies so markers remain available. Do not match only by visible text, bot
display name, or line number; outdated inline comments can have different
current line fields.

Use the appropriate list API for each kind and paginate through results with
bounded page, request, and elapsed-time budgets. Fetch a listing once per kind
per reconciliation pass and build a marker lookup. A positive trusted match
can be recorded even if a later page fails; absence on a partial listing can
never justify a resend. Multiple trusted matches are an anomaly to report,
not a reason to create or automatically delete another comment.

If a user deletes a confirmed comment or removes its marker, do not recreate
it automatically. The receipt remains proof of prior delivery. An unconfirmed
comment whose marker is removed remains unconfirmed.

## 5. Make GitHub outcomes useful for recovery

Extend `CommentPostResult` and both creation methods to return:

- Success: `ok: true`, GitHub comment ID and URL.
- Failure: bounded error code, HTTP status when present, retry/rate-limit
  information, and classification as definite rejection or ambiguous delivery.

An empty/undefined result is not proof of success. Update existing callers and
test mocks that currently depend on that behavior.

Add list helpers for PR review comments and PR issue comments. Pass abort
signals and finite request timeouts to all delivery/reconciliation requests.
Honor rate-limit instructions rather than repeatedly posting or scanning.
Review the installed Octokit configuration: creation requests must not be
silently retried by a transport plugin after an ambiguous failure.

Treat 422 responses according to their actual cause; validation, spam, and
rate-related failures must not all become an invalid-line fallback. Treat 401,
403, and 404 as permission/access/resource outcomes as appropriate, not as
proof that no previous comment exists.

## 6. Claim safely and recover without resending

For each `READY` row, use a short transaction and conditional update to save
`SENDING`, a random claim token, expiry, and attempt count. Only the winner
may issue the HTTP request. No database transaction stays open across GitHub I/O.

Immediately before dispatch, recheck the claim, active repository, and job
cancellation/timeout state. A valid successful response saves the receipt
conditionally against the same delivery identity and payload digest.

If the worker crashes, another worker may reconcile an expired `SENDING`
record, but it must not turn it back into `READY` and send again. A lease
cannot fence a request already accepted by GitHub. Preventing re-submission
of an ambiguous send is what closes this concurrency hole.

An original in-flight request may still finish after cancellation, timeout,
or claim expiry. Its receipt may be recorded as evidence without advancing
the job or authorizing any more sends. The UI must acknowledge that cancellation
cannot retract an already dispatched request.

Use PostgreSQL uniqueness and conditional writes as the authority; a Redis lock
or the normal BullMQ lock alone is insufficient protection against a stalled
worker continuing after another worker starts recovery.

## 7. Resume delivery before entering the AI pipeline

At worker entry, read the persisted job and plan before decrypting an AI key,
fetching a diff, calling a provider, or changing lifecycle phase:

- Missing/deleted jobs, inactive repositories, and terminal jobs must not post.
- A nonterminal job with a plan resumes from the saved plan at `POSTING`.
- A job with no plan runs the existing analysis and then prepares its plan.
- A duplicate queue execution for a completed job exits without GitHub writes.

Delivery retries need GitHub credentials, not a still-valid AI API key. They
must not consume another review quota reservation or regenerate findings.

Replace destructive error writes with structured error metadata that preserves
the saved review. Update cancellation and timeout paths too. They must preserve
delivery evidence and cannot resurrect a terminal job. Use conditional writes
and a consistent lock order rather than a read-then-unconditional-write check.

Reuse the current attempt infrastructure with bounded delivery/reconciliation
work. Respect `nextAttemptAt` and GitHub backoff without holding a worker in a
long sleep. When attempts are exhausted, keep the findings and receipts and
report `FAILED` with a precise delivery reason. No infinite resend/retry loop.

## 8. Deliver the summary and complete honestly

Keep the existing `summarize` configuration. When enabled, the one summary
slot includes confirmed inline counts and any definitively rejected inline
findings in its fallback section. When disabled, do not silently introduce a
new fallback comment; show undelivered findings in the dashboard.

Finalize and encrypt the summary body exactly once, after every inline row
has a known terminal outcome. Then send it through the same marker, claim,
receipt, and reconciliation mechanism. A crash after summary posting must
not produce a second summary. Do not count `UNKNOWN` as a rejected inline
finding and republish it in a summary.

Call `recordJobFindings` with the frozen findings and saved completion metadata.
Extend its transaction to verify the eligible job state, active repository,
and terminal delivery outcomes before setting `COMPLETED`. Terminal permanent
rejections can finish with an explicit partial-delivery warning; pending or
unconfirmed delivery cannot finish with an all-comments-delivered claim.

If all comments were delivered but final database publication fails, a retry
must skip delivery and retry only finalization. Preserve existing idempotent
historical occurrence and analytics behavior.

Cancellation and timeout remain terminal. Check them inside the completion
transaction so a race cannot overwrite them with `COMPLETED`.

## 9. Expose a small delivery report in Review History

Return versioned `metadata.commentDelivery` from `JobController.get` with:

- Expected, delivered, rejected, omitted, pending, and unconfirmed counts.
- Summary state: disabled, waiting, delivered, rejected, or unconfirmed.
- Safe GitHub links and bounded reasons where useful.

Display plain messages such as "3 of 5 inline comments delivered" and
"Delivery of 1 comment could not be confirmed; it was not posted again."
Keep findings readable even after delivery fails. Older jobs without records
show delivery as untracked, not retrospectively confirmed.

Do not add an automatic "retry all comments" control. After exhausted attempts,
the first release can provide an authenticated, repository-scoped read-only
reconciliation action for unconfirmed deliveries. It may save positive matches,
but must not post or turn absence into permission to resend. A deliberate new
review remains available and should explain that it can produce new comments.

## 10. Test the actual failure boundaries

Start with a worker regression demonstrating a crash after GitHub accepts a
comment but before the receipt is saved. Run the retry against the same durable
plan and a fake GitHub server that remembers accepted comments.

Required scenarios:

1. Crash before preparation commits: no GitHub request; next attempt prepares.
2. Crash after preparation but before claiming: resume without another AI call.
3. Crash after `SENDING` commits but before HTTP: reconcile, keep unconfirmed,
   and do not automatically resend.
4. GitHub accepts a comment, then the response is lost: marker reconciliation
   records the existing ID; one visible comment and one create request.
5. Response succeeds, but receipt persistence fails: same recovery behavior.
6. Receipt persists, then the worker crashes: skip it and continue remaining rows.
7. Summary accepted before crash: one summary after recovery.
8. All receipts exist, but `recordJobFindings` fails: retry publication only.
9. Two workers claim the same row: one dispatch. An expired claim and a late
   original response still cannot cause a second dispatch.
10. Definite transient rejection: bounded backoff and safe retry. Ambiguous
    5xx/transport errors: reconciliation only.
11. Definitive invalid location: one tracked fallback summary when enabled;
    visible partial delivery when disabled.
12. Pagination beyond page one, listing failure/cap, matching marker from the
    wrong author, multiple matches, and a removed marker: no unsafe resend.
13. Cancellation, timeout, disconnect, and deletion before/during delivery:
    stop new sends, retain evidence appropriately, never overwrite terminal state.
14. Reordered findings or upgraded renderers: reuse saved keys and exact bodies.
15. Retry with missing AI key or changed settings: use the frozen artifact.
16. Completed-job replay, deliberate new manual review, new head SHA, and legacy
    jobs: follow their explicitly different policies.

Use real disposable PostgreSQL tests for uniqueness, claims, preparation races,
conditional terminal writes, and cascade deletion. Mock-only tests cannot prove
those database properties. Run focused Vitest suites, the full backend suite,
frontend tests for delivery reporting, and both builds. Verify encrypted payloads
and repository/user isolation as part of integration testing.

## Files expected to change

| Area | Files |
| --- | --- |
| Schema | `apps/backend/prisma/schema.prisma` and a new additive migration |
| Preparation/delivery | New `apps/backend/src/services/comment-delivery.service.ts`, delivery contracts, and focused tests |
| GitHub adapter | `apps/backend/src/services/github.service.ts` and tests; trusted posting-actor resolution in the GitHub App service if needed |
| Worker/retries | `apps/backend/src/workers/analysis.worker.ts`, `job-state.ts`, their tests, and queue retry handling as needed |
| Completion | `apps/backend/src/services/historical/occurrence.service.ts` and tests |
| API/UI | Job controller and tests, a repository-scoped reconciliation route, History page and delivery-report component/tests |
| Lifecycle/docs | Relevant disconnect/retention paths, `deploy/DEPLOY.md`, and a shipped delivery-behavior document |

## Retention, legacy jobs, and rollout

- Keep minimal delivery receipts/identity for the retained job's lifetime.
  Apply existing retention policy to encrypted review data and purge delivery
  payloads on repository disconnect; reconnection must not reset known or
  ambiguous rows to `READY`. Deleted jobs cascade to their delivery records.
- Once job identity/receipts are deleted, the same commit may be treated as a
  new review. Do not claim suppression beyond that retention boundary.
- Apply the migration and regenerate Prisma before starting the new worker.
  Drain/stop old workers before cutover; mixed versions could bypass tracking.
- Use the new mechanism for newly prepared reviews. Never automatically backfill
  sendable plans for legacy jobs that may already have posted unmarked comments.
- Legacy untouched queued jobs may enter the new path only when it is known they
  never ran. Legacy running/retrying/posting jobs without a plan require explicit
  review or abandonment; phase alone is not sufficient evidence of no prior send.
- If a legacy completed job is replayed, exit without posting. Do not remove or
  modify historical GitHub comments during migration.
- Roll back by pausing delivery, not by restarting a worker that posts without
  consulting existing receipts. Do not drop the delivery tables during rollback.
- Validate on a designated test PR during operator rollout. Local implementation
  validation must not post comments to production repositories.

## Recommended implementation order

1. Add the lost-response/crash regression and agree on the conservative
   unconfirmed-delivery policy described above.
2. Add schema, encrypted plan preparation, immutable identities, and real
   PostgreSQL concurrency tests.
3. Extend the GitHub adapter with IDs, error classification, trusted author
   handling, markers, and bounded paginated reconciliation.
4. Implement claims and delivery state transitions, then make the worker resume
   a prepared plan before any AI work.
5. Route the summary through delivery tracking and protect finalization,
   cancellation, and failure persistence.
6. Add delivery reporting and read-only reconciliation, finish lifecycle tests,
   and document deployment/cutover.

The work is complete when a saved review survives every tested crash boundary,
confirmed comments and summaries are reused, ambiguous sends are surfaced
without automatic repeats, concurrent attempts cannot dispatch the same item,
and the dashboard accurately distinguishes analysis from comment delivery.
