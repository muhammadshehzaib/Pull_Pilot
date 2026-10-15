# Customer safety and capacity verification

Verified against this workspace on 2026-10-16. These are code and local test
results, not a certification of the deployed service.

## Answers

| Question | Result |
| --- | --- |
| Could a drafted test trigger customer CI? | Yes, before this change: the app created a branch and committed the test inside the customer's repository. Whether secrets were available depended on customer CI. |
| Is that automatic publication still possible through the draft feature? | Blocked in the changed code. Confirmed API requests return `409 write-disabled`; direct service calls also refuse. Existing PR records remain readable. |
| Does the app now execute drafted tests in an isolated runner? | No. The feature now generates, edits, and downloads drafts only. It neither runs them nor publishes them. A draft is not a verified test. |
| Can one signed-in customer read another customer's connected private content? | No such access was observed in the checked code paths and local tests. Ownership is checked before GitHub access; private access is checked against the signed-in GitHub identity. This is not a full production penetration test. |
| Is capacity for thousands of active customers verified? | No. The shipped topology and local checks do not establish that capacity. See the bottlenecks and required staging validation below. |

## Implemented protection

- The test-draft controller refuses new publication before acquiring a write
  client or changing draft status. The former GitHub-writing implementation has
  been removed from the draft publication service; no confirmation or browser
  claim of sandbox success authorizes it.
- The UI offers a local text-file download of the current edited draft instead
  of creating a branch or PR. It explicitly states that the service has not run
  the code. Downloading text does not execute it.
- Server/client path guards reject shared setup/module initialization and
  execution configuration, including `conftest.py`, `__init__.py`, setup files,
  test-runner configuration, and hidden paths. Allowed test code is still
  untrusted; filename checks are not a sandbox.
- Existing branches, commits, PRs, and CI runs are not deleted or canceled.
  Deploy both backend and frontend changes. The backend block protects old
  clients after deployment; a local code edit does not protect the live server.

## Customer-isolation evidence

| Boundary | Evidence and limits |
| --- | --- |
| HTTP authentication | Signed JWT identity supplies `req.auth`; client-provided user IDs do not establish ownership. Auth tests pass. |
| Repositories, reviews, rules, drafts, finding feedback, behavioral requests | `requireRepositoryAccess` queries the resource through the signed-in owner, rejects a foreign installation, and checks current GitHub permission using the stable GitHub account ID. HTTP tests exercise all 22 protected route/method combinations for a second signed-in customer. |
| Actual GitHub membership | `getRepoForUser` binds the numeric repository/account IDs and requests effective collaborator permission. It ignores the server token's own repository permissions as evidence of customer access. GitHub outages fail closed. External GitHub behavior is mocked in local tests. |
| Background review jobs | The worker checks persisted repository ownership, installation ownership, active status, and current GitHub access before reading code or delivering saved reviews. Forged queue installation IDs do not select another customer's credential. |
| Live updates | New tests use real local Socket.IO connections and signed JWTs. Anonymous/forged clients are rejected. Bob receives only Bob's activity, even after requesting Alice's room. Alice's private payload reaches Alice only. |
| API keys | Vault reads/writes are keyed by the signed-in owner. The vault GET exposes provider/update metadata, not the decrypted AI key. |
| Cached source | Cache keys include repository ID and blob SHA; source bodies are encrypted. Existing cache/context tests cover repository separation and concurrent review inventories. Real database integration was not run. |
| Dashboard | Analytics queries are scoped to the authenticated actor and active repositories; foreign repository filters are refused. Dashboard responses disable shared caching. |

The current repository model also refuses connecting a repository already linked
to another account. That is a single-owner connection model, not a complete
organization/team membership product. Customers with access to the same GitHub
repository do not automatically share this app's review history.

## Verification performed

- Backend: **1,506 tests passed**, **62 tests skipped** across five PostgreSQL
  integration suites. All other 93 test files passed.
- Frontend: **215 tests passed** across 28 files.
- Backend and frontend TypeScript checks passed (`tsc --noEmit`; frontend with
  `--incremental false`).
- Local authorization concurrency check: **1,000 HTTP requests**, at most **50
  in flight**, alternating two signed-in customers and their own/foreign job
  IDs. All **500 authorized reads succeeded** and all **500 foreign reads were
  denied**. The test uses the real Express routes and access middleware, with
  simulated persistence, GitHub responses, authentication decoding, and final
  controllers. It verifies concurrent authorization behavior; it does **not**
  measure database, queue, AI, GitHub, or full review capacity.
- Shared-setup and publication regression tests reproduced the unsafe behavior
  before the implementation and pass after the fix. Download tests verify the
  current edited content and absence of a publication API call.
- The bulk HTTP test has a 15-second test deadline. An initial full-suite run
  alongside the frontend exceeded its original five-second test timeout; all
  authorization assertions completed, and the suite passes with the appropriate
  bounded deadline. This is not evidence of production throughput.

## Capacity findings

The production compose file defines one backend instance. `index.ts` starts the
HTTP API, Socket.IO, BullMQ worker, polling, and maintenance in that same process.
The worker has **five concurrent review slots**. This is queueing support, not
proof of capacity for 1,000 simultaneous reviews.

For illustration only, with five slots and no overhead/retries/upstream delays:

| Assumed average review duration | Ideal throughput ceiling | Time to finish a burst of 1,000 reviews |
| --- | --- | --- |
| 60 seconds | 300 reviews/hour | 3 hours 20 minutes |
| 120 seconds | 150 reviews/hour | 6 hours 40 minutes |

These are arithmetic examples (`slots × 3600 / duration`), not measured
performance. The number of registered customers is different from the number
of simultaneous reviews and the rate at which they arrive.

Observed limits that matter before a large launch:

1. There is no separate API/worker deployment or distributed Socket.IO adapter.
   Simply adding backend replicas can strand user updates on another instance;
   every replica also starts polling and maintenance.
2. The fallback poller loads all active webhook-less repositories and polls them
   sequentially. Large inventories can take longer than the configured tick;
   overlap protection is local to each process.
3. Monthly quotas use atomic review reservation, but paid/public reviews can be
   unlimited. Monthly limits do not provide per-user concurrency/fair scheduling,
   queue backlog bounds, or protection against one tenant occupying the workers.
4. Test drafting calls the AI provider in the HTTP request. Its route has no
   specific per-customer concurrency/rate limit. Feedback/dashboard rate limits
   are per process and do not cover all expensive routes.
5. Production compose specifies no CPU/memory budgets, pool sizing, autoscaling,
   or target queue latency. Redis has persistence and no-eviction behavior, but
   backlog/storage growth still needs monitoring and admission control.
6. Database sizes, actual query latency, concurrent quota reservations, GitHub
   installation quotas, provider limits, and long-run retention/maintenance
   costs have not been measured with a representative deployed workload.

## Deployment verification still required

Docker's local engine is unavailable, and no disposable PostgreSQL/Redis staging
stack was supplied. The five database integration suites were deliberately
skipped; production customer data was not used for tests. No production load or
live cross-account test was attempted.

Before claiming support for thousands of active customers:

1. Bring up a disposable staging stack matching production with seeded users,
   private repositories, and separate GitHub App installations. Run the existing
   guarded PostgreSQL integration suites on a local `_test` database. Never point
   their migration/cleanup fixtures at production.
2. Verify two real test accounts can access their own content and cannot access
   each other's IDs, GitHub installations, vaults, cached context, downloads,
   feedback, or socket updates. Revoke GitHub access and repeat the read/write
   and queued-review checks.
3. Define an arrival rate, burst size, acceptable review queue wait, API p95
   latency, error budget, and workload mix. Test representative repository/diff
   sizes, AI durations/rate limits, cancellation, retries, and reconnects.
4. Load the full staging API → Redis → workers → PostgreSQL pipeline. Record
   per-customer completion/denial results, p95/p99 latency, backlog age, CPU,
   memory, DB connections, Redis disk/memory, and upstream errors. Include a
   noisy customer and ensure others keep receiving service.
5. Separate worker/API roles, add distributed socket delivery and distributed
   admission/fairness controls, then test restarts, multiple instances, and a
   sustained run through maintenance intervals. Repeat against explicit targets.

Automatic drafted-test execution/publication remains disabled. Implement and
independently validate the isolated execution and authorization requirements in
the [plan](customer-safety-capacity-plan.md) before offering that feature again.
