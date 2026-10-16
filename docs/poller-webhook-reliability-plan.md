# Poller and GitHub webhook reliability

## Confirmed issues

- The scheduled poller awaits the initial repository query without a catch at
  the timer boundary. Both its immediate run and subsequent timer callbacks can
  reject without a handler. The poller now runs in the separate worker process,
  so the remaining risk is termination of that worker and interruption of its
  active reviews, rather than termination of the API process.
- The global Express JSON parser defaults to 100 KiB, but nginx allows 25 MiB.
  A valid GitHub delivery above 100 KiB is rejected before signature verification
  and job creation. Access logging currently starts after parsing, so those
  failures also bypass the usual access log.

## Implementation plan

1. Catch failures at the scheduled poll boundary, log bounded diagnostics without
   error messages, and always release the overlap guard. Preserve the next
   scheduled retry and per-repository failure isolation. Test initial and later
   database failures, recovery, and overlapping timer ticks. Review and push.
2. Apply a 25 MiB JSON parser only to the GitHub webhook endpoint, retaining raw
   bytes for signature checks and the 100 KiB limit for other API requests. Move
   access logging ahead of parsing; return a clear, fixed 413 response and safe
   size diagnostics when a body exceeds its limit. Keep nginx and backend limits
   aligned. Test signed large push/PR deliveries, tampering, exact limits,
   chunked requests, malformed JSON, and ordinary API limits. Review and push.
3. Run the backend regression suite and production build, document outcomes and
   deployment limitations, and verify GitHub master contains both fixes.

## Scope and deployment

This does not guarantee database-backed reviews can proceed during an outage;
it prevents the poller from crashing the worker and retries polling afterward.
Deploy the updated backend/worker to activate the fixes. Limits remain bounded;
GitHub itself does not deliver payloads beyond its documented 25 MB cap. This
does not add automatic webhook redelivery or change queue persistence behavior.

## References

- https://nodejs.org/api/process.html#event-unhandledrejection
- https://expressjs.com/en/5x/api.html#express.json
- https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap

## Verification results

- Poller fix: 12 focused tests passed, including first-run database failure,
  later timer failure, retry after recovery, no overlap while a query is pending,
  timer shutdown, and safe logging. Backend production TypeScript build passed.
- Poller fix pushed to master as `23d2160`.
- Webhook fix: 13 real HTTP integration tests exercise the production Express
  app, real JSON parsers, signature middleware, webhook controller, and access
  logger. Database, quota, and queue dependencies are mocked; unrelated routes
  are stubbed. Signed push/PR payloads above 100 KiB are queued; exact 25 MiB
  payloads succeed; one-byte-over, chunked-over, and decompressed-over requests
  receive 413. Invalid/missing signatures remain rejected. Ordinary API limits
  and exact billing raw-byte capture remain intact. Malformed JSON receives a
  safe 400; rejected requests appear in access logs without query strings or
  payload contents.
- Final backend regression suite: **1,539 passed, 62 skipped**. The skipped
  database integration tests require a configured test database. Backend
  production TypeScript build passed. Changes reviewed and `git diff --check`
  passed. No live production database outage or nginx runtime test was performed.

## Operational behavior after deployment

- Polling retries at the existing configured interval (normally 60 seconds),
  with no overlapping cycles. Production polling remains disabled by default;
  this protection applies when it is explicitly enabled.
- The GitHub JSON endpoint accepts 26,214,400 bytes, matching nginx `25m`.
  Other JSON endpoints remain capped at 102,400 bytes. The backend reports
  `PAYLOAD_TOO_LARGE` plus the byte limit for parser rejections. Nginx can reject
  larger requests before the backend; those use nginx's own 413/access log.
- Redeploy both the API and worker from master. This change adds no database
  migration. Previously rejected deliveries are not recovered automatically;
  inspect GitHub webhook delivery history and redeliver them after deployment.
