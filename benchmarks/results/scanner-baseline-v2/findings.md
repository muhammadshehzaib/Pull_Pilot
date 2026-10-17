# Commerce bug lab: completed measurements

The corpus now contains **192 distinct changes and 96 known bugs**. Fifty new
targets cover payments, orders, products, actual disposable database operations,
and faulty tests. Every target has a fixed control and an executable regression
proof. The original 40 authored targets and six historical source reconstructions
are retained.

## Separate domain commits

| Area | New bugs / fixed controls | Commit |
| --- | --- | --- |
| Payments | 10 / 10 | `323f5a4` |
| Orders | 10 / 10 | `588ec7f` |
| Products | 10 / 10 | `9ecb864` |
| Database | 10 / 10 | `fafb511` |
| Faulty test code | 10 / 10 | `de26092` |

The foundation, domain integration, documentation and artifact reliability fixes
have their own commits. The results are saved in a separate final commit.

## What was executed

- **110 benchmark checks passed**, with no failures or skipped checks. These
  include all 90 authored bug/fix proofs, actual SQLite operations, patch
  application, private-label separation, exports, archived corpus compatibility,
  scoring and checkpoint-write fault handling.
- The backend TypeScript build passed.
- The scanner review ran all 192 changes three times: **576 completed attempts**.
  The completed run had no failed or degraded case attempts.
- Payments use a local fake gateway; database proofs use a new SQLite `:memory:`
  database per version. No customer database or real payment gateway was used.

## Scanner findings

| Group | Distinct known bugs | Caught per pass | Incorrect comments |
| --- | --- | --- | --- |
| Original authored cases | 40 | 5 | 0 |
| Historical source regressions | 6 | 0 | 0 |
| Payments | 10 | 0 | 0 |
| Orders | 10 | 0 | 0 |
| Products | 10 | 0 | 0 |
| Database | 10 | 0 | 0 |
| Faulty tests | 10 | 0 | 0 |
| Total | 96 | 5 | 0 |

The same five original security findings appeared in all three passes: SQL
interpolation, shell interpolation, untrusted innerHTML, disabled TLS validation,
and JWT decoding used as authentication. Their exact payloads were checked
against the previously inspected baseline and their reproduction checks still
pass. Labels are Codex-assisted, not independent human adjudication.

There were **no findings on the 50 new domain bugs or their fixed controls**.
Domain recall is therefore 0%; domain precision is unavailable because there
are no predictions. Across all groups, scanner recall is 5/96 (5.2%). Median
case duration was approximately 163 ms and p95 approximately 185 ms in this local
Windows run. No AI API calls were made, so API cost was $0.

These are measurements of built-in offline scanners. They do not establish
combined AI-plus-scanner accuracy or server/queue/GitHub latency. The old 5/46
recall and new 5/96 recall have different denominators; the difference is not a
measured regression in the reviewer. Repeated attempts are not independent bugs.

An earlier attempt stopped while writing a Windows checkpoint after 222 saved
cases. That partial run was retained under local ignored benchmark storage. The
runner now uses atomic checkpoint replacement and bounded file-lock retries;
the reported 576-attempt run was completed afterward. The partial attempt is not
included in this accuracy table.

## Next exercise

Review one domain at a time with a configured model, inspect its findings and
adjudicate against the supplied contracts. Preserve the fixed controls to measure
incorrect comments. Use a separate holdout before making competitive claims.
AI and CodeRabbit comparative accuracy remain unmeasured.

```powershell
npm run benchmark:test:domains
npm run benchmark -- --mode live --provider GEMINI --domain payments --out .benchmark-runs/payments-ai
```

See the [domain guide](../../domains/README.md) for all 50 scenarios and the
[machine-readable report](report.json) for per-domain/category/repetition metrics.
