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

- Draft-only safety previously pushed as `2d1a2b6`; revalidation pending.
- Remaining issues pending in the sequence above.
