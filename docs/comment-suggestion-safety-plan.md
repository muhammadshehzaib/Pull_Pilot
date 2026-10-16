# Safe review advice on GitHub

## Problem

The review finding's `suggestion` field mixes English advice and code examples.
The formatter puts both inside a GitHub `suggestion` fence, whose contents GitHub
can apply literally to the customer's source. Embedded backticks can close that
fence early and turn the remaining model output into comment formatting.

## Plan

1. Treat the existing field as advice for manual review. Remove one-click GitHub
   suggestion blocks entirely; neither a prompt nor a code-looking heuristic
   proves that text is a correct replacement for the selected source range.
2. Render advice in a read-only text block with a backtick fence longer than any
   backtick run inside it. Escape finding descriptions and fallback text so
   model-controlled Markdown, HTML, and filenames cannot change the layout.
3. Clarify the shared AI prompt. Keep the stored finding schema and identities
   compatible, and record the new rendering version on new delivery artifacts.
4. Upgrade old pending `READY` payloads before claiming them. Authenticate the
   saved payload, regenerate it from the frozen finding/summary, then atomically
   replace its encrypted bytes and hash only while its old hash is still READY.
   Preserve destinations, delivery IDs, markers, artifact hashes and receipts.
   Never rewrite or resend SENDING, UNKNOWN or DELIVERED requests.
5. Test the parsed Markdown structure, including English advice, code examples,
   nested suggestion fences, long backtick runs, line endings, malicious issue
   text and filenames. Exercise delivery retries, legacy payload upgrades,
   uncertainty, payload integrity and concurrent claims.
6. Run focused tests, the full backend suite and production build; review the
   diff, then commit and push to `master` and verify the remote commit.

## Acceptance criteria and deployment

- Newly sent finding advice never creates a GitHub Commit suggestion button.
- Untrusted text cannot escape into additional Markdown blocks or raw HTML.
- Legacy definitely-unsent comments use the same safe rendering; accepted or
  uncertain comments retain their existing conservative reconciliation behavior.
- No database migration, new secret, or frontend change is required.
- Stop/drain old review workers before deploying the updated backend and worker.
  A GitHub push alone does not deploy the running service. Historical comments
  remain unchanged; maintainers must inspect/remove any old unsafe suggestions.
- Real database tests require a disposable PostgreSQL database. Report skipped
  tests and live GitHub verification separately from local passing checks.

GitHub documents [applying suggestions](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/incorporating-feedback-in-your-pull-request)
and [containing nested code fences](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks).

## Verification results

- Implemented steps 1–5 and reviewed the formatter and delivery changes. Current
  advice is read-only, including code-looking advice; the server does not guess
  whether a snippet is a valid replacement patch. Findings and hashes retain
  their previous schema and identities.
- Full backend suite: **1,660 passed, 74 skipped** across 109 test files.
  Production backend build and `git diff --check` passed.
- Tests parse the generated Markdown with CommonMark (test-only dependency),
  rather than relying on fence substring checks. They cover nested fences,
  prose/code advice, malicious descriptions/paths, long delimiters and CRLF/CR.
- Real encryption/preparation/delivery services with an in-memory database and
  fake GitHub verify legacy READY inline/summary upgrades, unchanged frozen
  artifacts, digest checks, stable retries after rate limits, lost upgrade races,
  and preserved SENDING/UNKNOWN/DELIVERED bytes and reconciliation markers.
- Added two opt-in PostgreSQL cases for concurrent legacy upgrades and positive
  reconciliation of old accepted comments. These were skipped: no disposable
  database is configured, and the local Docker engine is unavailable. No live
  GitHub comment test or production deployment was performed.
- The full-suite redaction test now checks parsed displayed text as well as the
  outgoing body, so escaped brackets remain visibly `[redacted]` and the actual
  credential is still absent.
