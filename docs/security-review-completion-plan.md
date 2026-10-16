# Plan: complete security reviews with consistent finding identities

## Confirmed cause

`prepareReviewDelivery` hashes raw findings. `recordJobFindings` normalizes those
findings before hashing them. Deterministic security scanners emit `ruleKey`,
which normalization preserves as `ruleKeys`. The exact identity includes
`ruleKeys`, so the hashes disagree for a standalone scanner finding. GitHub
comments can already be delivered when completion throws. Existing pipeline
tests mock completion, and database delivery tests use a plain BUG finding,
so neither catches this case.

## Plan

1. Add a regression using a real SAST/secret finding and the real preparation,
   delivery and completion services. Confirm that it fails before changing code.
2. Normalize trusted findings before freezing, deduplicating, hashing and
   rendering new delivery plans. Keep their provenance/rule IDs and metadata.
3. Support unfinished plans saved by the old code only after checking their
   encrypted frozen findings against the original saved hash and the normalized
   completion findings. Preserve immutable plans and existing comment receipts.
   Never bypass changed-finding, pending-delivery, or terminal-job checks.
4. Test ordinary and security findings, exact retries, old-plan recovery, genuine
   mismatches, unfinished sends, and terminal jobs. Add equivalent opt-in real
   PostgreSQL coverage and run it if a disposable local database is available.
5. Run the backend regression suite and production build, review the diff, and
   push to the branch selected by the user (the existing default is master).

## Scope

This fixes false failure for future reviews and eligible pending/retrying plans.
Already FAILED jobs remain terminal; this does not automatically restart them,
repost comments, or recover jobs already deleted by retention. Successful
COMPLETED reviews remain outside the existing failed-job cleanup policy. No
database migration is planned.

## Verification

- Before the fix, both real-scanner regression cases (SAST and SECRETS) posted
  their fake GitHub comments and then failed in `recordJobFindings` with
  `Comment delivery is unfinished or review changed`.
- After the fix, all 20 new service regression tests passed. They run real
  scanners, encryption, preparation, delivery, completion, and analytics logic,
  with an in-memory Prisma substitute and fake GitHub connector. They cover
  normal and security findings, equivalent singular/plural rule IDs, stable
  normalization at the 20-key cap, retries without duplicate sends/occurrences,
  old raw-hash plans, changed fields, damaged hashes/ciphertext, unfinished
  comments, and terminal reviews.
- Added three opt-in PostgreSQL cases for real SAST/SECRETS completion,
  finalization retries, completed-review survival of failed-job retention, and
  old-plan compatibility. These were not run: the local Docker engine is
  unavailable and no disposable PostgreSQL test database is configured.
- Full backend suite: **1,559 passed, 65 skipped** (database integration tests).
  Backend production TypeScript build and `git diff --check` passed. The change
  was reviewed; no production deployment or live GitHub comment test occurred.

## Deployment behavior

Redeploy the backend API and separate review worker from the chosen branch.
There is no new database migration or configuration setting. New plans freeze
canonical findings. Eligible older plans retain their original hashes and
receipts; completion checks their authenticated frozen findings before accepting
the normalized equivalent. A security finding can still have a FAIL security
check or advisory BLOCK verdict while the review job correctly ends COMPLETED.
The failed-job retention policy is unchanged and does not select these completed
reviews. Already terminal failures are not automatically restarted.
