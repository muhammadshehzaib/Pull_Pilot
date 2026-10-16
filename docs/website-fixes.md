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

## 33 — Exact rules repository selection

Plan: load every repository page before resolving a deep link. Missing/inactive
targets must require explicit selection instead of substituting the first repo.

Implemented: a shared paginated repository loader feeds the rules picker. Unknown
deep links show an explanation and leave the picker unselected; Add remains
disabled until selection. Repository load failures show an error and retry.
Validation: four rules-page tests cover later-page deep links, missing/inactive
targets, explicit selection, and failed loading/retry. Web typecheck and lint passed.

## 34 — Failed loads versus empty data

Plan: make loading, successful empty responses, and read failures distinct. Do
not offer vault writes until the existing key state has been read successfully.

Implemented: the vault hides its edit/create/delete controls until a successful
read and offers retry on error. History, repository, and rules lists now show
retryable errors instead of empty-state invitations on failed reads. Rules list
errors are attributed to their requested repository.
Validation: 22 page tests passed, including pending vault reads, failed reads,
existing-key recovery, and genuinely empty responses. Web typecheck and lint of
the vault/rules pages passed.

## 35 — History request ordering

Plan: cancel obsolete list/detail requests and guard every result, failure, and
loading-state update with its request identity. Poll the current query and read
the latest selected review rather than a captured old selection.

Implemented: navigation invalidates an old list request immediately. List/detail
requests have separate controllers and sequences, polling does not overlap, and
late background refreshes cannot replace a newly selected review.
Validation: 18 history tests passed, including delayed poll responses across page
and filter changes and late detail successes/errors. Web typecheck passed. History
lint still reports two pre-existing state-in-effect errors in the unchanged
finding-feedback/risk detail effects; the request-handling lint errors/warnings
from the starting code were removed.

## 36 — Rules request ordering

Plan: scope rules reads, loading/error updates, and post-save refreshes to the
current repository and request. Ignore obsolete requests even after A → B → A.

Implemented: one guarded rules loader handles initial reads, retry, and mutation
refreshes. Repository changes abort outstanding reads immediately. Old mutation
results cannot refresh another repository, show the wrong success/error message,
or clear the newly selected repository's draft.
Validation: nine rules tests passed, including late successes/errors, switching
away and back, retry, and an old save completing after a repo switch. Web typecheck
and rules-page lint passed.

## 37 — Complete history repository filter

Plan: load repository options independently of review pagination, following every
repository page and including inactive connections with retained history.

Implemented: history uses the shared repository loader, sorts the full picker,
and keeps its options when filtering reviews. Filter-load failures have a separate
retry and do not prevent browsing the review list.
Validation: 29 history/rules tests passed, including a later-page inactive repo,
filtering without visiting its reviews, and filter-load failure/retry. Web typecheck
passed.
