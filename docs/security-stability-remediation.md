# Security and stability remediation plan

Implement, regression-test, review, commit, and push each issue separately.
Pushed code is not a production deployment.

1. Drafted tests: preserve draft-only mode. Verify confirmation, shared setup
   paths, and claimed sandbox results cannot publish executable code. There is
   no validated arbitrary-test runner; generation, editing, and download remain.
2. Logout: persist server-side revocation until token expiry; enforce it on HTTP,
   installation redirects, and socket authentication. Disconnect revoked local
   sockets. Failed revocation must fail logout; the UI stays signed in and offers
   a retry if the logout call fails.
3. Secret masking: use constant redaction with no prefix or suffix. Verify
   short/long secrets and credential findings/comments.
4. Backend container: run application and migrations as an unprivileged user;
   preserve required writable paths and document private-key permissions.
5. Browser container: pin the version-matched official image by registry digest,
   enable Chromium sandboxing, provide restrictive user-namespace seccomp rules,
   and refuse execution when the host cannot support sandboxing.
6. Registration errors: inspect account/repository registration; replace raw
   upstream errors with fixed client messages and allowlisted log metadata.
7. Key derivation: use asynchronous scrypt with bounded concurrency; update all
   callers, preserve ciphertext compatibility, and test event-loop responsiveness.
8. Customer regex denial of service: isolate evaluation, bound time/memory/input,
   terminate hung work, and report incomplete checks without a clean pass. Split
   API and review-worker deployment roles.
9. Long scanner input: bound diff/line sizes before regex scans, contain execution,
   report reduced coverage, and test adversarial long lines and line locations.

Run focused tests/type checks for each change and full backend/frontend/runner
regression tests at the end. Inspect staged diffs before each push. Use synthetic
fixtures. Record commit IDs, migrations, tests, and rollout limitations. Unavailable
Docker/PostgreSQL runtime checks must be reported as unrun, never passed.

References: [Playwright Docker](https://playwright.dev/docs/docker),
[Node asynchronous scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback),
[Node worker threads](https://nodejs.org/api/worker_threads.html).

## Progress

- Draft-only safety revalidated and pushed as `f6952c7` (49 tests passed).
- Logout: persistent hashed-token revocation, unique login tokens, HTTP/socket
  enforcement, socket expiration/disconnection, and truthful retry UI. 127 backend
  and 13 frontend tests passed; both TypeScript checks passed. Apply migration
  `20261016010000_session_revocation` before serving requests with this code.
  Database unavailability fails authentication/logout closed. Existing tokens
  remain usable until expiry or logout; logged-out tokens are denied immediately
  on later authentication and before further socket deliveries.
- All listed issues now have pushed code changes or a verified, preserved
  fail-closed mitigation. Runtime deployment checks remain explicitly unrun.
- Full credential masking pushed as `130442e`; 140 scanner/worker tests passed.
- Backend image now uses UID/GID 1000 with owned runtime files, dropped Linux
  capabilities, and no privilege escalation. Deployment key ownership instructions
  are updated. Docker runtime verification remains unavailable on this machine.
- Browser sandbox/digest pin pushed as `3c5002f` (19 runner tests passed).
- Safe registration/API error handling pushed as `1f2c69a` (62 tests passed).
- Key derivation now uses asynchronous scrypt, with four active derivations and
  a bounded waiting queue. All vault, worker, context-cache, import-cache, and
  comment-delivery callers await results. Existing ciphertext remains readable;
  legacy compatibility, tampering, responsiveness, and overload tests pass.
  All 1,509 backend tests and backend TypeScript validation pass; 62 database
  integration tests remain skipped without disposable PostgreSQL infrastructure.
- Customer patterns now use RE2 instead of JavaScript backtracking; unsupported
  syntax is rejected/skipped and matching has a batch budget. API and workers
  deploy separately, with Redis progress transport and distinct CPU/memory caps.
  105 focused tests, backend TypeScript, and compose validation pass. Docker
  containers were not started because the local engine is unavailable.
- Long-line protection bounds review inputs before parsing and scanner matching.
  Built-in SAST/secrets execute in terminable threads with time/memory limits.
  Omission, timeout, and failure produce partial coverage instead of a clean
  result. 70 focused scanner/worker tests and backend TypeScript checks pass.

## Pushed issue commits

| Issue | Commit |
| --- | --- |
| Preserve draft-only publication safety and reject setup-file bypass | `f6952c7` |
| Persistent logout revocation, socket enforcement, and truthful retry UI | `f1d283e` |
| Constant credential redaction with no visible suffix/prefix | `130442e` |
| Unprivileged backend runtime and key permission instructions | `b4b321d` |
| Digest-pinned browser image and required Chromium sandbox | `3c5002f` |
| Safe registration/API error responses and logging | `1f2c69a` |
| Async, bounded, backward-compatible key derivation | `c1d52c4` |
| RE2 customer patterns and separate API/worker containers | `cacd0f7` |
| Bounded scanner input and terminable probe threads | `6a4dce7` |

## Final review and validation

- Backend: **1,523 passed**, **62 skipped** database integration tests.
- Frontend: **215 passed**. Browser runner: **19 passed**.
- Backend production build and frontend TypeScript check passed.
- Production compose syntax validated with `docker compose config --quiet`.
- Compiled JavaScript scanner smoke passed: real isolated SAST/secrets findings,
  no copied credentials, and explicit partial coverage for oversized input.
- Real-thread tests cover valid scanners, termination of an infinite loop, and
  failure without results. Pipeline unit tests use real detector functions with
  thread startup mocked, avoiding OS scheduling interference with fake timers.
- Review added an input guard before thread-data cloning and rejects unsupported
  scanner names. No customer input chooses an executable module or script.

## Required rollout checks

1. Stop/drain the old combined backend worker. Apply session migration
   `20261016010000_session_revocation` (normal production migration startup does
   this) before serving the new authentication code.
2. Ensure the mounted GitHub App key is owned/readable by UID 1000 with mode 600.
   Redeploy backend, separate worker, and frontend. Verify non-root UID and key
   access. Starting only the API will leave reviews queued.
3. Run a disposable browser smoke test on the Linux host. Chromium must start
   with its sandbox enabled and the supplied seccomp policy. Keep failure closed
   when the host cannot support user namespaces; do not disable the sandbox.
4. Run guarded PostgreSQL integration suites on a disposable test database,
   including session replay and concurrent customer access. Docker's engine and
   such a database were unavailable here, so those checks are not reported as
   passed. No production load test or production deployment was performed.

Generated tests remain editable/downloadable only; automatic publication is
disabled. This is the safe mitigation for the listed CI exposure, not a claim
that an arbitrary generated-test runner has been implemented. Large-customer
capacity also remains subject to the staging checks in the capacity report.
