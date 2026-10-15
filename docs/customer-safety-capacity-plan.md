# Draft execution safety, customer isolation, and capacity verification

## Findings and scope

Generated test PRs currently create branches and commit executable files inside
customer repositories. Their existing CI can run those commits with secrets; a
confirmation checkbox does not attest that CI is isolated. Test-directory path
validation also permits shared setup such as `tests/conftest.py`.

There is no implemented isolated runner for generated test drafts. The separate
behavioral sandbox does not validate or authorize arbitrary drafted tests. Docker
is installed locally but its engine is unavailable. Do not pretend that filename
validation, a draft PR, a fork, or a skip-CI commit message proves safe execution.

## Implementation

1. Block automatic test-draft publication at both the controller and the GitHub
   writing service. Existing published PR records remain readable. Confirmation,
   edited content, and direct service calls must not bypass the block. Keep
   generation/editing available and add browser download for inspection and
   offline execution. Clearly state that the service has not run these drafts.
2. Reject shared setup/configuration/module-initialization files on both server
   and client, while preserving ordinary source test paths. This reduces accidental
   broad execution; it does not certify any allowed test as safe.
3. Audit authenticated routes, owner-scoped DB queries, GitHub identity and
   installation checks, worker authorization, socket rooms, context caches,
   quotas, and execution boundaries. Add two-customer concurrent route tests and
   socket isolation tests where current coverage is missing.
4. Inspect queue concurrency, worker/API topology, polling, bounded reads,
   admission limits, and deployment configuration. Record a capacity model using
   measured or explicitly assumed review durations. Run a bounded local HTTP
   concurrency test against the real authorization middleware with synthetic
   persistence/GitHub responses; label that as a middleware check, not an
   end-to-end throughput benchmark.
5. Run backend and relevant frontend tests and type checks. Record exact passes,
   skips, and unresolved deployment checks in a verification report. Do not load
   customer production systems or read customer secrets. No production capacity
   claim is valid without a disposable deployed stack, real database/Redis,
   representative workloads, upstream limits, and target latency/error criteria.

## Completion and remaining deployment work

Ship a safe draft-only mode now. Re-enabling publication requires a separately
implemented runner and authorization flow: disposable execution, no customer or
platform secrets, constrained network/CPU/memory/time, no host mounts or Docker
socket, pinned tooling, tenant-bound input/output, and human review of exact code
before a separately authorized privileged action. An isolated test pass itself
must never authorize execution in secret-bearing CI.

The report must distinguish enforced code paths and passing tests from production
deployment facts that cannot be verified from this workspace. Keep changes local
for review unless the user requests a GitHub push for this work.
