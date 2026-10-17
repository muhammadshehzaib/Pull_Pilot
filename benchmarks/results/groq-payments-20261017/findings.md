# Groq-hosted payment checks — 2026-10-17

The benchmark's configured endpoint was **Groq**, not xAI Grok. The saved key
authenticated successfully when listing models. A documented and available model,
`openai/gpt-oss-120b`, was then used through the existing OpenAI-compatible Grok
adapter. [Groq model documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b)
and [API compatibility](https://console.groq.com/docs/openai).

Credentials were loaded privately by the runner. The agent did not inspect or
display environment files or secrets. No SDK error bodies or authorization
headers were copied to these results. Application credentials and production payment services were
not used. No suggested payment code was applied to the application.

## What completed

Across this session, four distinct payment cases completed:

| Phase / case | Outcome |
| --- | --- |
| Smoke: declined payment incorrectly marked paid | Target bug caught; one valid HIGH finding. |
| After format fix: stable retry key control | One unsupported MEDIUM warning about hypothetical missing IDs. |
| After format fix: terminal payment status control | No comments. |
| After format fix: declined-payment status control | No comments. |

The smoke and later controls used different JSON-format instructions. They must
not be merged into a single completed accuracy experiment. The full original
192-case corpus and its ground truth were not changed. The new provider/model
results are separate from the earlier Gemini runs.

## Failures retained

| Saved phase | Attempts / completed | Result |
| --- | --- | --- |
| `initial-model-failure/` | 1 / 0 | Requested xAI model `grok-4.3` at the configured Groq endpoint; HTTP 404. |
| `smoke/` | 1 / 1 | Available Groq-hosted model successfully reviewed the unfinished declined-payment bug. |
| `pre-format-batch/` | 1 / 0 | HTTP 400 on the first control; stopped with 19 planned cases unattempted. |
| `after-format-batch/` | 4 / 3 | Three controls completed, then HTTP 429; stopped with 16 planned cases unattempted. |

Total: **seven review requests, four completions, three failures**. The two
read-only model-list requests are not review attempts. No requests followed the
429. The saved error does not identify which account quota dimension was reached.

The initial model failure and smoke predate endpoint-aware metadata, so their
unchanged raw records say `GROK`. Their actual service was Groq. Later records use
`provider: GROQ`, `adapter: GROK`, and Groq-labelled token usage. [audit.json](audit.json)
records the phases and HTTP statuses from the sanitized console output. Original
failures remain intact; later attempts do not replace them.

## Fixes made while testing

1. `510f25d` identifies Groq hosting separately from the reused adapter and adds
   `--max-failures 1`. A batch now records its first failure, saves its full plan,
   and can stop without spending requests on the remaining cases. The earlier
   pre-format attempt records that commit's original local identity `a2e61bf`;
   its later amendment only excluded unrelated documentation from the commit.
2. `dead814` makes the shared instructions consistently request
   `{ "findings": [...] }`, including `{ "findings": [] }` for a clean change.
   Previously they allowed or requested a top-level array while the adapter
   selected JSON-object mode. The parser still accepts legacy array responses.
   All four provider tests cover the object response and consistent instructions.

The original HTTP 400 was normalized to a safe generic error, so its exact
upstream cause is not available. The formatting contradiction was independently
identified in source; the subsequent three successful calls show that the new
request works, not that every possible API formatting failure is solved.

## Incorrect comment and unsafe advice

The stable-key control correctly deduplicates retries for the shown order. The
model assumed missing, null, or empty identifiers without an evidenced caller or
input contract requiring them. This repeats one of the unsupported hypotheses
seen in the earlier Gemini run; it is labelled **false positive**, not quietly
removed or counted as a new bug.

The suggested fallback generates a fresh key when an ID is missing. Even in its
own hypothetical scenario, retries then receive different keys and can charge
twice. All three cases (`undefined`, `null`, empty string) are reproduced in
[suggestion-checks.test.cjs](suggestion-checks.test.cjs), using a fake gateway.
This verifies a flaw in proposed remediation; it does not expand corpus ground
truth or turn the unsupported warning into a detection.

The valid declined-payment finding had no verified added-line anchor. Its
content belongs in the existing general-summary fallback, not a claimed inline
comment location. Adjudication is Codex-assisted source/contract inspection, not
independent human review.

## Timing, usage, and cost

Successful reviews took 1.32–2.98 seconds each in this small session. This is
review-core timing, excluding queue and GitHub delivery, and is not a stable
performance estimate. The four completions reported 8,391 input tokens and
2,163 output tokens. Cache-hit metadata was missing, so exact automatic cost
totals remain **unknown**, not zero.

At the published standard rates ($0.15/M input, $0.075/M cached input, $0.60/M
output), the reported successful tokens have a list-price equivalent of roughly
**$0.00193–$0.00256**, depending on cache hits. This excludes unknown usage on
failed calls and any account-specific discounts, free quota, or billing terms.
It is not an invoice or the cost of the whole session.
[Published Groq pricing](https://console.groq.com/docs/model/openai/gpt-oss-120b).

## Local checks and remaining work

The backend build and all 308 focused provider/context/response checks passed.
The benchmark suite passed 115 checks in this workspace: 113 tracked checks and
two checks belonging to concurrent local-model work. The three additional
remediation proofs in this folder passed separately. Software tests establish
workflow compatibility and fixture behavior, not AI review accuracy.

The remaining payment reviews and all new Groq reviews of orders, products,
database bugs, and faulty tests remain **unfinished due to rate limiting**. In
the final batch only clean controls completed; it provides no measurement of
post-format-change bug recall. Do not report a completed multi-domain benchmark,
claim that incorrect comments are eliminated, or combine these results with
Gemini to hide incomplete cases.

When quota is available, review the still-unreviewed cases in fresh directories,
keeping the successful controls and failed attempts. In particular, test the
retry-idempotency bug and webhook replay before proceeding to other domains.
[resume-plan.json](resume-plan.json) lists the 97 of 100 authored domain cases
still outstanding under the latest JSON-format policy, including the one failed
case. The earlier successful smoke remains a separate phase.
