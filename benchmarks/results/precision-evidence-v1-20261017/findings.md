# Evidence-first review policy: limited live check

Production change: `45441b3` (`fix(review): require supported regressions before commenting`).
This changes the shared review instructions used by Gemini, OpenAI, Claude, and
Grok. It uses the existing single review call, with no extra verifier request.
The provider output format, severity filtering, and security scanners remain
compatible. There is no keyword blacklist that discards model findings.

## What changed

The previous instructions asked for structural improvements and heavily emphasized
memory optimization and clean architecture. They also allowed unsupported
scenarios to be downgraded to a lower severity instead of discarded. These goals
encouraged optional notes and speculative defect claims on otherwise correct fixes.

The new policy requires a supported trigger, a cause in the change, and a concrete
consequence. It checks before/after behavior and supplied contracts, avoids invented
input types and ownership/lifetime assumptions, and asks for fixes that preserve
the documented behavior. Unchanged limitations and unsolicited cleanup are omitted.
Explicit user rules can still require style or coverage findings. Removed guards,
newly exposed defects, attacker-controlled inputs, and synchronization regressions
remain valid findings; a reproduction test is not required to report them.

Repository context is explicitly untrusted data. Contracts help establish intended
behavior; they do not prove the implementation correct or override review rules.

## Observed result

One previously noisy clean case completed after the change:
`seed-payments-retry-idempotency-clean`.

| Same frozen case | Original policy | New policy |
| --- | --- | --- |
| Model | gemini-2.5-flash | gemini-2.5-flash |
| Status | Completed | Completed |
| Unsupported defect claims | 2 | 0 |
| Optional cleanup notes | 1 | 0 |
| Total comments | 3 | 0 |
| Review-core duration | 29.86 seconds | 5.32 seconds |

The original two claims assumed conflicting or missing order identifiers without
an evidenced trigger. The cleanup note reported the unused random-ID parameter.
The new model response was empty, rather than comments being removed by a server
filter. The corpus and frozen input SHA-256 values match the original run. Model
generation settings are unchanged; the production instructions changed.

Original run and adjudication:
[run](../payments-gemini-20261017/run.json),
[labels](../payments-gemini-20261017/labels.json).
New [run](clean/run.json) and [report](clean/report.md) preserve timing and usage.
Exact cost remains unavailable because cache usage metadata is missing.

## Quota blocker and limits of this evidence

The next request was the corresponding known-bug case,
`seed-payments-retry-idempotency-bug`. It returned `ai-rate-limited` (HTTP 429 in
the sanitized console output). Its [failed attempt](bug-attempt/run.json) is
retained, with no findings and no usage available. Further live requests stopped.
The failure does not establish whether the minute or daily limit was reached.

This is **one development case, one completion, and one failed request**. It is
not a completed accuracy benchmark, does not prove that all five original false
warnings are resolved, and does not establish preserved bug recall or a latency
improvement. The fixture was known during policy development, and model output
varies. No broad precision or competitor claim is supported by this check.

## Local verification

- Backend TypeScript build passed.
- 308 focused provider, context, and response checks passed, including 16 new
  checks that all four adapters send the policy, accept clean reviews, and retain
  security, malformed-input, and explicit-rule findings.
- All 110 benchmark checks passed, including the 90 authored before/fix proofs.

Mock provider tests establish policy delivery and response compatibility only;
executable fixture proofs establish the labelled bugs. Neither measures model
accuracy. The frozen benchmark cases and labels were not rewritten for this change.
The `.env.benchmark` file was loaded privately by the benchmark, never opened,
displayed, or copied to results.

## Resume when quota is available

1. Retry the failed idempotency bug case once in a fresh output directory. Keep
   the failed request in these results; do not replace it with a later success.
2. Run the other three previously noisy controls and their buggy counterparts:
   `declined-as-paid`, `webhook-replay`, and `currency-mismatch` in the payments
   domain. Use `--case seed-payments-<scenario>-clean` or `-bug` with the existing
   live runner. Check each outcome before proceeding and stop on another quota error.
3. Complete the other payment pairs, including removed signature checks, refunds,
   currency conversion, and event ordering. Adjudicate all comments against code
   and contracts. Report both false comments and bug recall, retaining API failures.
4. Evaluate other domain groups before tuning on their model outputs, followed by
   previously unseen real PRs. Record any later tuning so they are no longer
   described as unseen evaluation data.

Do not rerun this successful clean case just to obtain a preferred output. Repeat
the complete planned set only when estimating variation, and report every attempt.
