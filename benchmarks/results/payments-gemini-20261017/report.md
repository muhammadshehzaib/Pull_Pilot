# PullPilot review-quality benchmark

Run: `af16bf7a-06e9-4739-ab20-48ae387db96f`  
Mode: **live**  
Corpus SHA-256: `857fc05536484fd69670c812257b1d874cb397099354e800bf2dec1448520348`  
Reviewer: Codex-assisted source/contract inspection plus executable target proofs; not independent human adjudication

This is a review-core benchmark, not a deployed GitHub/queue throughput test. See run.json for provider/model, exact scope, errors, token usage and pricing provenance.

| Metric | Result |
| --- | --- |
| Distinct cases / known bugs | 20 / 10 |
| Case attempts, including repetitions | 20 |
| Successful / failed | 18 / 2 |
| Known bug detections / opportunities, including repetitions | 8 / 10 |
| Recall (failed cases remain in denominator) | 80.0% |
| Precision (adjudicated bug comments) | 61.5% |
| Precision with duplicate noise | 61.5% |
| Incorrect / duplicate / non-bug comments | 5 / 0 / 8 |
| Pending comments | 0 |
| Fixed-control attempts with incorrect comments | 4 / 10 |
| Median / p95 successful case duration | 12054.6 / 29856.4 ms |
| Estimated API cost, USD | unavailable (not zero) |

| Category | Known bugs | Detected | Incorrect comments | Recall |
| --- | --- | --- | --- | --- |
| payments | 9 | 7 | 5 | 77.8% |
| security | 1 | 1 | 0 | 100.0% |

| Domain | Known bugs | Detected | Incorrect comments | Recall |
| --- | --- | --- | --- | --- |
| payments | 10 | 8 | 5 | 80.0% |

## Interpretation

Scanners are not expected to detect general logic or cross-file contract bugs. Historical cases reverse selected source changes from public merged fixes; they are not original bug-introducing PRs. Forward fixes are target-regression controls, not guarantees of globally clean code. Authored pairs are deliberately small and are not representative production traffic. Public fixes may have appeared in model training. Results must be reported separately by family.

Adjudication uses the concrete trigger and relevant code. Keyword matches are only suggestions. Unmatched comments remain pending until judged. False means an incorrect or unsupported bug claim; valid optional/style/test advice is counted separately as non-bug. New valid defects are separate additional true positives, not extra recall. An empty prediction set has unavailable precision. Reported model costs are estimates from supplied rates, not an invoice. Repetitions of the same case are not independent new bugs; inspect per-repetition metrics in report.json. This small convenience sample does not establish production accuracy or a statistically significant competitor advantage.

CodeRabbit: not run; no authenticated comparison runner/repository configured. Never infer competitor accuracy from an absent result.

## Source PRs

- [axios/axios#7369](https://github.com/axios/axios/pull/7369) — base `04cf01969ed58f96920da032f340bfe4614aab90`, head `14440e3ec0f60ae84945ff89c6733a7bfcf5966a`
- [expressjs/body-parser#698](https://github.com/expressjs/body-parser/pull/698) — base `266e69e976baa21add0e99efe69d264ccb1da69a`, head `a639447a4ac46ecd190199bc9704f835f72f6a0d`
- [expressjs/body-parser#716](https://github.com/expressjs/body-parser/pull/716) — base `b849bd533d8b4abf5576a3e301f28d9befa05ddd`, head `cce82c7d76f581019ee063e8477bf7ab895b8d8c`
- [expressjs/body-parser#742](https://github.com/expressjs/body-parser/pull/742) — base `dd153dd61c4a42b225b496de866ed1b81b5c5c6b`, head `3479c957a9b7bab9a8d5eafae98c73088784ec97`
- [axios/axios#11216](https://github.com/axios/axios/pull/11216) — base `790b2ca8b6d8486dde3ce54cda20990ba91b0831`, head `cfbeb73b1f4fa4ba011c8c167b900befcd3a73c6`
- [axios/axios#11225](https://github.com/axios/axios/pull/11225) — base `790b2ca8b6d8486dde3ce54cda20990ba91b0831`, head `33f984a355ac43274d27bb4adf38a68e85650bab`
