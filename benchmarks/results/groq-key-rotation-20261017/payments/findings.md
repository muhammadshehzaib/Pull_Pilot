# Resumed payment reviews after a key change

Service: **Groq**, model: `openai/gpt-oss-120b`. These are not xAI Grok results.
The 17 cases left by the prior [resume plan](../../groq-payments-20261017/resume-plan.json)
were reviewed without repeating the three completed controls. The production
review policy remains the JSON-object policy from `dead814`; configuration
isolation was fixed in `c0dda17`.

All **10 known payment bugs were detected**: client amounts, unstable retry keys,
unsigned webhooks, declined payments, cumulative refunds, currency mismatches,
terminal-state downgrades, JPY conversion, repeated fulfillment, and negative refunds.
The target bug findings match the frozen contracts and executable reproductions.

One new unsupported warning remains: the fixed sequential-refund control was
criticized for hypothetical undefined `refundedCents`, without an evidenced
caller or supported input requiring it. It is labelled false positive. The prior
three controls were not rerun; one of those already had an unsupported ID warning.
Do not infer that all payment comments are now correct.

The 17 first attempts include **15 fully successful pipelines, one scanner-degraded
attempt, and one HTTP 413 rejection**. The degraded attempt returned a valid empty
AI review of the JPY control; a local quota observer initially ran inside scanner
worker threads. Its worker guard was fixed, and the same-input offline scanner
recovery passed without repeating the paid model call. The HTTP 413 carried a
35-second retry delay; a later explicit request completed successfully. Both
original problems remain in the first-attempt report, and both recoveries are
saved separately. Thus all 17 pending cases received an AI review, while the
first-attempt operational failure count remains two.

New first-attempt defect-comment precision is 10 / 11 (90.9%) on this small,
known development sample. This is not a measured production rate, a competitor
comparison, or proof that prompt changes alone caused an improvement. Missing
cache metadata and usage on rejected requests prevent an exact session cost.

Several correct findings cover removed guards and have no verified added-line
anchor; they belong in the existing general-summary fallback. The replay warning
correctly identifies repeated fulfillment, but its additional double-charge
example is not established by the shown fulfillment function. Generated fixes
were inspected as advice and were not applied to application payment code.

The shared constants previously imported Prisma's generated runtime, which
could load application `.env` defaults after the private benchmark configuration.
`c0dda17` makes the provider enum a type-only import. The compiled benchmark
dependencies now load without reading any environment file implicitly. For this
session the Groq endpoint and model were explicitly pinned in child-process
configuration. No environment file was inspected or displayed by the agent.

Adjudication is Codex-assisted source/contract inspection, not independent human
review. All 306 focused configuration/provider checks, the backend build, and all
113 benchmark checks passed. Input and corpus hashes match the original fixtures.
