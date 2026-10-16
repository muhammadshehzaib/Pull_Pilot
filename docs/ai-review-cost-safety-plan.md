# Bounded AI reviews and retry safety

## Confirmed problems

- Claude requests allow 4,096 output tokens and ignore `stop_reason`. A cut-off
  JSON answer fails parsing and is treated as an ordinary retryable error.
- All four providers wrap errors as generic Errors, losing authentication and
  request status. BullMQ allows three total attempts, so invalid keys and bad
  generated answers can invoke the same request repeatedly.
- Anthropic and OpenAI-compatible SDKs also default to internal retries. These
  can multiply queue attempts; they are not three guaranteed billable calls.
- Existing scanner bounds do not bound the full labelled AI prompt, surrounding
  context or custom guidelines. The raw GitHub diff has no review admission cap.

## Implementation plan

1. Add server-owned limits: 64 KiB of raw diff, 100 changed files, 96 KiB for the
   complete system/user prompt, and 8,192 output tokens per AI call. Reject an
   oversized review before AI dispatch with instructions to split the PR or
   reduce context. Measure UTF-8 bytes, including labels and guidelines. Keep
   existing scanner bounds and incomplete-scan reporting.
2. Ask for at most ten concise, prioritized model findings, with short issue/fix
   descriptions. State this policy in the review summary. Deterministic security
   and repository-rule findings remain separate and are not capped by this rule.
3. Check provider finish reasons before parsing. A cut-off, blocked, empty or
   malformed answer must not be published as a successful review or silently
   repaired into one. Stop automatic replay and show a fixed actionable error.
4. Preserve a typed, safe error through every provider. Invalid keys, access or
   billing problems, bad requests, invalid responses and ambiguous network
   failures stop automatic retries. Explicit rate-limit and server failures may
   use the existing bounded queue retries. Disable SDK-level retries so there
   is one retry owner. Never echo raw SDK messages, request bodies or keys.
5. Connect permanent AI failures to the worker's terminal/error and quota-refund
   path. Protect the same auxiliary AI JSON calls with prompt/output limits and
   response validation; optional test-gap failure remains best-effort. A failed
   database write when settling a permanent AI error must not allow AI replay.
6. Test real providers against SDK mocks, exact limits, multibyte input, output
   truncation (including syntactically valid partial output), key/status mapping,
   error privacy, SDK options and worker retry/terminal behavior. Run the full
   backend suite and production build, review, commit and push to `master`.

## Limits of the fix and deployment

These byte bounds are an admission/cost policy, not a tokenizer or a guarantee
that every provider/model accepts a request. Oversized PRs are rejected, not
silently shortened or split into extra paid requests. Truncated responses stop
after that call; there is no automatic paid continuation. A provider can still
charge for work already performed. This does not implement billing refunds or
guarantee exactly one AI request across process crashes/database outages before
the existing delivery plan is persisted. Explicit transient retries can still
cost money depending on provider behavior. No live customer key will be used
for tests. Existing platform review-quota refunds are separate from AI bills.

Deploy the updated backend/API and separate worker together after draining old
workers. No migration or new secret is required. A GitHub push alone does not
deploy the running app.

Sources: [Claude stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons),
[Gemini finish reasons](https://ai.google.dev/api/generate-content), and the installed
Anthropic/OpenAI SDK retry options and error types.

## Validation results

- Implemented all six steps and reviewed the provider, worker and admission
  paths. New limits are server-owned constants; repository settings cannot
  increase them. Oversized raw diffs are rejected before ignore filtering and
  scanner bounds; the complete labelled/context/rules prompt is checked again
  immediately before SDK dispatch.
- **250 focused tests passed. Full backend: 1,754 passed, 74 skipped** across
  111 test files. The production backend build and `git diff --check` passed.
- Added 68 cases across the four real provider implementations with SDK mocks,
  17 admission/error-classification cases, eight worker cases and an empty-key
  factory case. Checks cover exact byte/file boundaries, Unicode, server-label
  expansion, system/rules and auxiliary prompt limits, output budgets, SDK retry
  disabling, valid JSON with a truncated stop reason, malformed/empty output,
  excessive findings, structured key/rate/billing failures and log privacy.
- Worker tests use the real Claude provider with a fake SDK and a three-attempt
  driver. Truncated answers, malformed JSON and invalid keys invoke the SDK
  once, then throw BullMQ's UnrecoverableError. Transient rate/server errors
  remain retryable. A failed terminal database write still cannot replay AI;
  existing queue-failure/recovery settlement handles the eventual database write
  and platform review-quota refund.
- Missing/malformed result containers now fail explicitly instead of becoming
  an empty successful review. A genuine completed `[]` or array wrapper remains
  valid. More than ten model findings fails explicitly instead of silently
  dropping findings. Deterministic findings are unaffected by this model cap.
- The 74 existing opt-in integration tests were skipped because their services
  are not configured locally. No live AI-provider call, GitHub comment test,
  production deployment or provider billing verification was performed.
