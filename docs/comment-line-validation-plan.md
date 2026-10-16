# Plan: verify inline review comment locations

## Confirmed issue

Providers return model-selected paths/line numbers. Normalization currently
truncates fractional numbers, delivery trusts the result, and nearby-finding
deduplication can select an earlier line while retaining another finding's text.
Prompt instructions alone do not validate a location.

## Implementation

1. Generate opaque labels from the reviewed diff's exact added lines. All review
   providers receive labelled old/new line numbers and request a label plus exact
   line citation. Resolve accepted labels to server-calculated paths/numbers.
   Never persist or render the raw citation (it could contain credentials).
2. Preserve only server-verified label metadata through trusted normalization.
   Check it against the reviewed diff again before freezing a delivery plan.
   Deterministic scanners/rules use their parsed added-line locations. Reject
   invalid/fractional numbers instead of rounding to a neighbouring line.
3. Keep findings without a verified location in history and a durable summary;
   never send them inline or move them to a guessed nearby line. A safety summary
   is required even when the optional routine summary is disabled.
4. Prevent merging verified findings across distinct locations. Preserve
   existing confirmed receipts. Older pending plans without location proof must
   omit unsent inline comments and use one tracked summary, without blind
   resending uncertain sends or changing frozen hashes/identities.
5. Test multi-hunk numbering, deletions/context/renames, neighbouring-line
   mismatches, wrong paths, ambiguous/forged labels, unsafe citations, all four
   providers, deduplication, completion, retries, and legacy plans. Run backend
   tests/build, review changes, and push master.

## Limits

Exact code citations and diff membership verify placement, not the truth of the
AI's reasoning. An AI can still select a real but semantically inappropriate
line. No code is automatically applied. Existing posted comments are not edited
or deleted. No database migration is intended.

## Verification

- Implemented and reviewed. All four providers use the shared labelled-diff and
  citation verifier. The pipeline binds deterministic findings before merging;
  delivery independently checks diff membership before freezing and checks the
  frozen finding's destination again before dispatch.
- Full backend suite: **1,638 passed, 72 skipped**. Production TypeScript build
  and `git diff --check` passed. No frontend changes or new migration are needed.
- 21 anchor tests cover numbering, renames, multi-hunk/deleted/context lines,
  neighbour mismatches, forged/missing labels, unknown files, unsupported paths,
  duplicate locations, raw-citation privacy, deterministic membership and merge
  safety. Twelve SDK-mocked provider cases cover all four providers, including
  response/log privacy on malformed JSON.
- Real preparation/delivery/completion services with an in-memory database and
  fake GitHub cover summary-only findings, disabled routine summaries, retry
  deduplication, legacy fallback creation, a crash before fallback creation,
  frozen-destination tampering, preserved delivered receipts and UNKNOWN/SENDING
  sends that must never be blindly repeated. Worker tests check reviewed-diff
  handoff and retaining a connector for a missing fallback summary.
- Added two opt-in PostgreSQL cases and updated existing delivery fixtures to
  supply real location proof. Database tests were skipped because no disposable
  PostgreSQL test database is configured; the local Docker engine is unavailable.
  No live GitHub posting test or production deployment was performed.

## Deployment and behaviour

Drain old workers before deploying the updated API/backend and review worker.
Only added, nonblank lines with unambiguous supported paths can receive inline
comments. Context-only, deleted, unknown or unsupported locations remain summary
findings. A routine `summarize: false` does not suppress the required safety
fallback. Raw source citations are used only to verify the AI request/response;
stored findings retain a bounded verified label, never the raw citation. Malformed
review JSON errors use fixed text to avoid echoing that citation into logs.

New plans store `commentLocationVersion: 1` inside the encrypted artifact, not a
new database column. Earlier frozen hashes and confirmed receipts remain intact.
Pending old inline sends without location proof become omitted and use one
tracked fallback summary. Existing uncertain claims remain uncertain until
positive reconciliation; they are never guessed or blindly resent. Already
posted comments are neither moved nor deleted. Location verification still
cannot prove that an AI selected the semantically best line or proposed a
correct replacement.
