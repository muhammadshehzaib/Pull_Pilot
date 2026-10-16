# What the first benchmark establishes

The baseline reviewed 92 distinct changes three times: 40 authored bugs, six
historical source regressions, and their 46 paired fixed controls. All 276
attempts completed. The same five authored security bugs were detected in every
pass. No comments were produced on any fixed control.

| Measure | Per pass |
| --- | --- |
| Known bugs caught | 5 / 46 (10.9%) |
| Authored bugs caught | 5 / 40 (12.5%) |
| Historical source regressions caught | 0 / 6 |
| Incorrect comments | 0 |
| Fixed controls with an incorrect comment | 0 / 46 |

Across all attempts, median scanner-core duration was approximately 240 ms and
p95 was approximately 269 ms on this Windows workspace. API cost was $0 because
no model or online advisory service was called. This is not full-review latency,
live AI cost or deployed throughput. Repeated cases are not independent new bugs.

## Detected

- SQL injection through an untrusted query interpolated into a SQL string.
- Shell injection through an untrusted directory interpolated into `exec`.
- HTML injection through an untrusted profile assigned to `innerHTML`.
- HTTPS certificate validation explicitly disabled.
- Authentication using `jwt.decode` without signature verification.

All 15 comments (five repeated in three passes) were inspected against their code,
contract and executable reproduction and labelled true positives. This was
Codex-assisted adjudication, not an independent human accuracy assessment.
100% observed comment precision on five distinct detections is a small-sample
result; it does not establish production precision or superiority over another
reviewer.

## Missed

The scanner layer missed the other 35 authored targets, including:

- Cross-tenant reads, shared-cache tenant key collisions and weakened admin guards.
- Path traversal, URL substring allowlist bypass, prototype-sensitive dictionaries,
  arbitrary expression evaluation and reflected credentialed CORS origins.
- Off-by-one pagination/index/expiry behavior, seconds-vs-milliseconds confusion,
  numeric sorting, string addition, rounding order and UTF-8 byte-limit errors.
- Empty-array reduction, missing callback returns, null dereferences and caller
  array mutation.
- Async map/forEach misuse, missing authorization await and swallowed bank errors.
- Lost transaction boundaries, concurrent overselling and unscoped deletion.
- Stateful regular expressions, listener/timer leaks and response fallthrough.
- Unchanged-caller price and synchronous/async contract regressions; infinite loops.

The six missed historical targets are reconstructed from:

1. [Axios #7369](https://github.com/axios/axios/pull/7369): inherited merge-strategy
   lookup can select a non-function for special config keys.
2. [body-parser #698](https://github.com/expressjs/body-parser/pull/698): invalid
   configured limits can silently disable downstream body-size enforcement.
3. [body-parser #716](https://github.com/expressjs/body-parser/pull/716): URL-encoded
   parameter counting is off by one.
4. [body-parser #742](https://github.com/expressjs/body-parser/pull/742): request
   reading mutates reusable parser options.
5. [Axios #11216](https://github.com/axios/axios/pull/11216): header matcher callbacks
   bind the wrong `this` value.
6. [Axios #11225](https://github.com/axios/axios/pull/11225): progress listener cleanup
   is missing and throwing final callbacks can interrupt remaining cleanup.

Historical source snapshots were inspected as text. Their upstream test suites
were not executed; the benchmark does not claim full historical reproduction.
All 40 authored targets do have executable regression demonstrations.

## Next measurement

Run the same corpus with a configured AI provider to establish combined
model-plus-scanner recall, incorrect-comment rate, time and token-based estimated
cost. Adjudicate actual model findings; do not label from keywords alone. The
current result is insufficient to decide whether the AI prompt, context or model
needs improvement. Do not tune to these examples and then advertise performance
on the same examples as an independent evaluation; reserve a separate holdout.

No AI API key was configured when this baseline was run. No authenticated
CodeRabbit CLI/connector or comparison repository was available. Therefore **full
PullPilot AI accuracy and CodeRabbit comparative accuracy remain unmeasured**.
