# First live AI payment benchmark — 2026-10-17

The benchmark loaded credentials privately at runtime. The `.env.benchmark` file
was not opened or displayed, and its contents are not stored in these results.
No production payment, customer database, or real payment gateway was used.

## First-pass result

Model: `gemini-2.5-flash`. Inputs: ten authored payment regressions and their ten
fixed controls. This was one pass using the production review adapter, frozen
contracts, default model generation settings and offline security scanners.

| Measure | Result |
| --- | --- |
| Cases attempted | 20 |
| Completed reviews | 18 |
| Provider failures | 2 |
| Known bugs detected | 8 / 10 attempted; 8 / 8 completed buggy reviews |
| Known bugs missed by a completed review | 0 |
| Operational recall, including failed cases | 80% |
| Confirmed target findings | 8 |
| Unsupported defect warnings | 5 |
| Optional cleanup/hardening comments | 8 |
| Total comments | 21 |
| Fixed controls with unsupported warnings | 4 / 10 |
| Confirmed defect-comment precision | 61.5% (8 / 13; optional advice excluded) |
| Median / p95 completed review-core duration | 12.1 / 29.9 seconds |
| First-pass elapsed time | 291.8 seconds |
| Exact total API cost | Unavailable |

Labels are Codex-assisted source/contract adjudication, not independent human
review. Optional advice is reported separately instead of silently counting it
as either a detected functional bug or an incorrect claim. All ten fixed
controls received at least one comment; many comments were low-value for the
specific regression being reviewed. Single-pass results can vary.

## Bugs caught

| Scenario | Finding |
| --- | --- |
| Client-controlled amount | Correctly identified undercharging from request-body data. |
| Retry idempotency | Correctly identified fresh retry keys creating duplicate charges. |
| Webhook signature | Correctly identified missing authentication before marking paid. |
| Partial refund total | Correctly identified cumulative refunds exceeding capture. |
| Currency mismatch | Correctly identified the missing currency comparison. |
| Delayed event | Correctly identified downgrading a terminal succeeded payment. |
| JPY conversion | Correctly identified multiplying JPY amounts by 100. |
| Negative refund | Correctly identified removing the positive-amount guard. |

The unsigned-webhook and delayed-event findings lack a verified inline anchor;
their content is valid, but delivery must use the existing general-summary
fallback. Content detection is not a claim that every finding is inline-ready.

## Cases still unreviewed

| Case | First pass | One follow-up attempt |
| --- | --- | --- |
| `seed-payments-webhook-replay-bug` | HTTP 503, provider unavailable | HTTP 429, rate limited |
| `seed-payments-declined-as-paid-bug` | HTTP 429, rate limited | Not retried after the quota blocker persisted |

The original failures remain in `run.json`. The follow-up is preserved under
`retry/`; it is not substituted into the first pass. Further requests stopped
after rate limiting persisted. These two cases are incomplete provider calls,
not demonstrated model failures to recognize their bugs. Retry only these cases
when quota is available; completed reviews do not need to be repeated.

## Unsupported warnings

Five comments on four fixed controls made defect claims that were not supported
by the supplied behavior contract or changed code:

1. The stable-order-key fix was criticized for hypothetical non-unique order IDs
   without an evidenced conflicting namespace.
2. The same fix was criticized for hypothetical missing/null order IDs.
3. Returning false for non-succeeded payments was said to violate a requirement
   to distinguish failure statuses, although no such requirement was supplied.
4. A caller-owned Set was assumed to have an indefinite lifetime and no external
   retention policy; its insertion operation already existed before the fix.
5. Currency reconciliation was criticized for undocumented string/major-unit
   inputs even though the contract specifies integer minor-unit values and the
   amount comparison was unchanged.

Several were labelled HIGH or MEDIUM despite lacking a demonstrated trigger on
documented inputs. One suggested fallback idempotency-key generation; fresh keys
on retries can recreate the very duplicate-charge problem under evaluation, so
generated remediation still needs review.

## Broader observations checked separately

Eight comments were classified as optional cleanup/hardening: unused parameters,
status constants, clearer error messages, observability, broader currency support,
and concurrent replay/refund handling.

The currency and concurrency observations were independently reproduced in
`scope-checks.test.cjs`:

- KWD is mishandled in both the original and fixed versions. The fixed JPY/USD
  examples work; broader currency support is a pre-existing limitation.
- Concurrent fulfillment can duplicate delivery in both versions. The actual
  target contract explicitly covers sequential event deliveries, and that fix
  succeeds.
- Concurrent refunds can exceed capture in both versions. The target contract
  explicitly covers sequential partial refunds, and that fix succeeds.

These are useful broader risks, but are not counted as newly introduced target
bugs or used to inflate recall. Their severity in the model output is often
stronger than the scope of the evidence. The original corpus was not rewritten
after seeing the model output.

## Usage and pricing limits

The 18 successful first-pass requests reported **28,432 input tokens and 55,286
output tokens including thinking**. At the published standard paid-tier rates,
those successful completions have a list-price equivalent of approximately
**$0.140–$0.146**, with the range covering missing cache-hit metadata. Rates were
checked on 2026-10-17: $0.30/M text input, $2.50/M output including thinking,
and $0.03/M cached input. [Google's official pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash)

This is not the actual invoice or an upper bound on the whole session. Free
quota, account pricing and failed-request billing are unknown. The two failed
first-pass calls and the failed retry returned no usage. The separate successful
smoke request is stored under `smoke/` and is excluded from the first-pass cost
range and accuracy metrics. Automatic cost totals remain unavailable when
required usage/cache information is missing.

## Verification and next step

The ten payment bug/fix proofs passed again. All three additional scope checks
passed. No model finding was applied to application code. No API key was copied
into Git or these artifacts.

When quota is available, retry the two failed cases separately, then expand to
orders. Use independent adjudication and a separate holdout before making
competitive claims. CodeRabbit comparative accuracy remains unmeasured.
