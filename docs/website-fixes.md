# Website fixes 31–38

Code audit confirmed all eight issues on starting revision `161f05c`. Each fix
is planned, checked, committed, and pushed individually in numerical order.

## 31 — Temporary authentication failures

Plan: distinguish a confirmed unauthenticated session (HTTP 401) from temporary
server/network errors. Preserve the route and any verified user; provide retry.

Implemented: the auth hook redirects only on 401. All five protected pages show
a retryable session-check error when verification is temporarily unavailable.
Tests cover temporary server/network failures, successful retry, verified-user
retention, and genuine unauthorized responses.

Validation: 21 auth/history/dashboard tests passed; web typecheck and lint of the
auth hook and error component passed.

## 32 — Failure explanations in history

Plan: display stored error/details/reason independently of the findings list,
and provide an explicit fallback for legacy reviews without a reason.

Implemented: the owned job detail API now exposes typed reason and details in
addition to its existing error field. History shows the explanation for failed,
timed-out, cancelled, and skipped reviews even when findings were retained.
Validation: 47 backend controller tests and 12 history tests passed; backend build
and web typecheck passed.
