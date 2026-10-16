# Preserve findings in wrapped AI review responses

## Confirmed issue

All four providers use the shared `reviewResponse`, which selects
`Object.values(raw)[0]`. Before the cost-safety fix, a summary string could be
normalized into an empty successful review. That fix now rejects strings, but
`{"summary": [], "findings": [realFinding]}` still selects the empty summary
array and returns no findings. A summary string before valid findings now fails
unnecessarily. Field insertion order must not determine review results.

The normalizer can also discard malformed entries from a nonempty array. That
must not turn a malformed model response into a successful clean review.

## Plan

1. Reproduce the ordering bug through the actual providers with mocked SDK
   responses before changing production code.
2. Select the findings array by an explicit supported property name:
   `findings`, `suggestions`, or `issues`. Continue accepting a top-level array.
   Ignore unrelated summary/metadata fields regardless of their order/type.
   Do not guess from an arbitrary first value, unknown array or nested object.
3. Require exactly one supported findings field in a wrapper. Reject conflicting
   aliases, wrong field types, unknown wrappers and over-limit arrays with the
   existing safe nonretryable `ai-invalid-response` error. Keep the ten-model-
   finding limit from the cost policy.
4. After normalizing, require one usable finding per supplied entry. Malformed
   entries fail the response instead of silently disappearing. Keep existing
   category/severity normalization and verified-anchor behavior; an unverified
   location can still be reported through the existing summary fallback.
5. Clarify the shared prompt: top-level arrays, or `{ "findings": [...] }` when
   a JSON-object response is required. A genuine empty findings array remains a
   valid clean result. A summary alone cannot prove a clean review.
6. Verify all providers, field orders, summary types, ambiguous/malformed
   wrappers, malformed members, explicit empty results, exact location evidence,
   count limits, error privacy and the worker's no-retry/no-post failure path.
   Run the full backend suite/build, review, commit and push to `master`.

## Deployment and limits

Deploy the updated backend/API and review worker together after draining old
workers. No migration, frontend change or new secret is needed. Historical
reviews already saved as empty are not automatically rerun: doing so would make
new paid AI requests. An operator/user can deliberately start a new review.
This validates the response structure, not whether the AI found every real bug.
A GitHub push alone does not confirm the running app has been deployed.

## Verification

- Reproduced the silent-empty bug before editing production code: all **12**
  new cases (three findings aliases across four real providers with SDK mocks)
  returned `[]` instead of the real finding when `summary: []` came first. Those
  same cases pass with the fix.
- Added **20** extractor cases, **92** provider cases and **3** worker cases.
  Providers preserve findings and exact verified locations with summary arrays,
  summary strings, either field order and unrelated nonempty metadata arrays.
  Explicit empty results still succeed. Conflicting aliases, unknown wrappers,
  wrong types and malformed/mixed entries fail without silently losing findings.
  Useful findings without verified coordinates still reach the summary fallback.
- Real Claude/worker tests with SDK mocks confirm malformed/ambiguous answers
  become FAILED, throw UnrecoverableError, invoke the SDK only once despite
  three configured attempts, and never prepare/post a successful review. Stored
  errors and progress messages do not echo private response text.
- **269 focused tests passed. Full backend: 1,869 passed, 74 skipped** across
  112 test files. The production build and `git diff --check` passed. Existing
  cost, location, delivery, quota and security tests remain passing.
- Reviewed the shared extraction/normalization path used by all four providers.
  No production code still chooses review findings via `Object.values(raw)[0]`.
  Unrelated test-gap/draft response contracts are unchanged.
- The 74 existing opt-in integration tests require services not configured
  locally and were skipped. No live AI-provider request, GitHub posting test or
  production deployment was performed.
