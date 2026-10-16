# Correct live dependency vulnerability severity

## Confirmed problem

The client treats OSV `/v1/querybatch` results as full advisories, but that API
returns only IDs and modified dates. Missing severity defaults to MEDIUM. The
previous live check of `vm2@3.9.17`, advisory `GHSA-248r-7h7q-cr24`, showed an
official CRITICAL record becoming MEDIUM and an individual SAFE verdict. The
same finding with the correct severity produces the app's advisory BLOCK.
The existing numeric-only severity parser also ignores valid CVSS vectors.

## Plan

1. Keep batch package lookup, then retrieve full records through
   `/v1/vulns/{id}`. Deduplicate detail requests within each scan, validate record
   IDs, respect withdrawn advisories, and preserve package/result alignment.
   Follow bounded pagination; do not report partial/invalid responses as clean.
2. Bound the work: at most 500 package refs, ten batch requests, three pages per
   package, 500 known advisory IDs and 200 detail requests, six concurrent detail
   requests, eight seconds per request and twenty seconds for the whole lookup.
   Limit default HTTP responses to 2 MiB each and 16 MiB in total. Propagate review cancellation and use
   injectable transports for deterministic tests. Cache only within the lookup.
3. Use a pinned CVSS implementation for 3.0, 3.1 and 4.0 plus the published FIRST
   base equation for 2.0. Validate
   numeric scores and vectors, inspect explicit severity and package-specific
   affected records, and preserve the highest valid severity rather than letting
   a lower first entry hide a critical score. Do not invent a critical rating.
4. Preserve known advisory IDs if details/severity cannot be resolved. Mark the
   package/scan incomplete, keep offline fallback evidence alongside partial
   live evidence, and explicitly label unknown severity. Assign these unresolved
   findings HIGH manual-review priority so they do not read as a SAFE clean bill
   of health; HIGH is then an app policy, not a claimed database severity.
5. Test ID-only bulk responses through real client, dependency probe and both
   risk engines: CRITICAL must remain CRITICAL and force advisory BLOCK. Cover
   CVSS standards/examples, mixed severity, affected-package targeting, missing
   data, outages, partial batches, pagination, deduplication, withdrawal, bounds,
   concurrency, cancellation, HTTP transport and offline fallback behavior.
6. Run focused/full backend tests and production build, repeat the public OSV
   example, review changes, commit and push to `master`, then verify remote HEAD.

## Deployment and limits

Deploy backend/API and review worker together after draining old workers. No
database migration, frontend change or new secret is needed. Existing trusted
`OSV_API_URL` mirrors must serve the detail endpoint as well as querybatch.
The pinned CVSS library is loaded through Node's native CommonJS/ESM interop:
use Node 20.19+ in the 20.x series, or 22.12+. The existing production Docker
image uses Node 22. README and backend engine metadata specify these minimums.
Budgets/caps can reduce coverage; reports must say so. Previously saved reviews
are not silently rewritten or rerun. BLOCK remains an advisory verdict; this
change does not install GitHub branch protection. A push alone does not confirm
production deployment. Public advisory lookups use no customer repository or
AI key, and no paid AI calls are needed to validate this fix.

References: [OSV batch response and pagination](https://google.github.io/osv.dev/post-v1-querybatch/),
[full advisories](https://google.github.io/osv.dev/get-v1-vulns/),
[CVSS specification](https://www.first.org/cvss/v4.0/specification-document),
the [CVSS v2 equation](https://www.first.org/cvss/v2/guide),
and [CVSS implementation](https://github.com/turingsecure/cvss.js).

## Verification results

- Implemented the six steps and reviewed the client, severity parser, dependency
  probe, cancellation handoff, fallback, risk and runtime paths.
- **Full backend: 1,955 passed, 74 skipped**, across 114 test files. The four
  dependency/OSV files contain 128 passing focused cases. The production build
  and `git diff --check` passed.
- Tests use the real ID-only batch shape and separate detail transport. They
  cover deduplicated GETs, package-specific ratings, case-sensitive advisory IDs,
  numeric/CVSS 2/3/4 evidence, conflicting scores, withdrawals, malformed/missing
  results, bounded/repeated pagination, package/ID/request/byte caps, six-request
  concurrency, whole-query/request deadlines, noncooperative transports, review
  cancellation, trusted mirror routing, HTTP failures, safe warnings and offline
  evidence retained alongside partial live results.
- Real client -> manifest/transitive lockfile probe -> both risk engines tests
  verify CRITICAL -> advisory BLOCK. Unconfirmed severity is explicitly labelled
  and gets HIGH manual-review priority -> REVIEW, never an invented CRITICAL
  database rating. Critical known/offline evidence survives partial detail loss.
- Repeated the previous public OSV example with the default HTTP transports and
  current built services: `vm2@3.9.17` / `GHSA-248r-7h7q-cr24` now produces
  **CRITICAL**, dependency **FAIL**, and **BLOCK** in both risk engines, with
  complete coverage for that lookup. No AI or GitHub-comment call was made.
- Confirmed the compiled CommonJS severity module loads and calculates CRITICAL
  on Node **20.20.2**, **22.20.0** and **22.23.3**. The CVSS dependency is pinned
  to `@turingpointde/cvss.js@2.1.0`; CVSS v2 uses FIRST's published base formula.
- The 74 existing opt-in integration tests were skipped because their required
  services are not configured locally. No real database/Redis integration run,
  Docker build, GitHub-comment test or production deployment was performed.
