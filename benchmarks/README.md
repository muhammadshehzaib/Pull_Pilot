# Review-quality benchmark

This benchmark measures the **review core** using frozen public/authored inputs.
It does not measure deployed queue capacity or prove that PullPilot outperforms a
competitor. The checked-in baseline runs **offline scanners only**, not an AI model.

## Dataset

`corpus.json` (domain-v2) contains **192 distinct changes / 96 labelled bugs**:

- 40 authored bug introductions and 40 paired fixes. All 40 mutations have an
  executable reproduction in `reproduction.test.cjs`; the safe and buggy versions
  are checked against the same trigger with in-memory stubs.
- 50 domain-specific bug introductions and 50 paired fixes: **10 each for
  payments, orders, products, database operations, and faulty test cases**.
  Every domain bug has an executable proof in `domains/`. Database proofs run
  real SQL against disposable in-memory SQLite databases; other groups use
  explicit local gateway/service test doubles. See [domain scenarios](domains/README.md).
- 6 public merged bug-fix PRs from Axios/body-parser, each converted into a source
  fix control and a reverse-fix regression. These are **selected source-file
  reconstructions, not original bug-introducing PRs**. Original regression tests,
  changelogs and unrelated implementation changes are excluded.

Historical snapshots retain PR URLs, base/head SHAs, file hashes and the original
MIT license notices in `real-pr-snapshots.json`. They are inspected as text and
never executed. The authored fixtures cover security, tenant authorization,
numeric/boundary bugs, async handling, transactions/races, leaks and cross-file
contracts. This convenience sample is small, mainly JavaScript, deliberately
balanced, and not representative of real defect prevalence. Public fixes may be
present in model training. A fixed control has no labelled target regression;
it is not a guarantee that the entire upstream file is bug-free.

The reviewer receives only the diff, frozen related files and a documented
behavioral contract. Bug labels, concrete triggers, candidate keywords, case IDs,
PR titles and provenance are withheld. Both variants have the same contract and
background context. Historical context is a bounded selection, not a full clone.

## Run

From the repository root:

```powershell
npm run build --workspace=apps/backend
npm run benchmark:test
npm run benchmark -- --mode scanners --out .benchmark-runs/scanners
```

This runs the actual production diff filter, security probes, anchor binding,
severity filtering, deduplication and risk engine. OSV and Semgrep are disabled
for reproducibility. Scanners run in their normal bounded worker threads.
General logic bugs are expected to need the AI reviewer. The following are
outside this benchmark: GitHub fetching/delivery, queue waiting, automatic
context discovery, stored repository rules, test-gap/draft calls and behavioral
execution. Do not report this as a full deployed review benchmark.

For a **paid live run**, set a key in the ignored `.env.benchmark` file (never
commit it or paste it into results):

```dotenv
GEMINI_API_KEY=your-real-key
GEMINI_MODEL=gemini-2.5-flash
```

Supported key names: `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`),
`ANTHROPIC_API_KEY`, `GROK_API_KEY` (or `XAI_API_KEY`). Claude/Grok accept the same
model environment settings as the app. OpenAI uses the app's configured-in-code
`gpt-4o`. The runner loads only `.env.benchmark`, not production credential files
or database vaults. Every case has a fresh request and no shared chat history.

```powershell
# Smoke run first: at most four paid requests, no automatic retries.
npm run benchmark -- --mode live --provider GEMINI --limit 4 --out .benchmark-runs/gemini-smoke

# Full corpus, repeated three times: 576 paid requests.
npm run benchmark -- --mode live --provider GEMINI --repetitions 3 --out .benchmark-runs/gemini-full
```

`--family seeded|domain|historical-pr`, `--domain payments|orders|products|database|test-cases`,
`--case <id>`, `--limit N`, `--seed <text>` and
`--timeout-ms N` select scope/order. Default timeout: 90 seconds per model call.
The runner checkpoints every attempt and refuses to overwrite an existing run.
Checkpoints use atomic replacement with bounded retries for transient Windows
file locks, preserving the previous completed checkpoint if saving fails.
Failed cases remain in recall's denominator, are counted separately, and are
never called successful clean reviews. A failed/unavailable scanner is disclosed.
An API failure may still have been billed; unknown cost is not zero.

Select one domain to review its ten bugs and ten fixed controls independently:

```powershell
npm run benchmark -- --mode scanners --domain payments --out .benchmark-runs/payments
npm run benchmark:test:domains
```

Reports include separate per-domain and per-category metrics. All 90 authored
targets (40 original plus 50 domain targets) have executable failure/fix proofs.
SQLite proofs require Node 22.13+ or a newer supported runtime with `node:sqlite`.
The domain proof suite is distinct from running the reviewer: a passing proof
establishes the fixture's regression, not that PullPilot detected it.

## Cost

Production provider adapters expose an optional usage observer containing only
model IDs and provider-reported token counts. Default app behavior is unchanged.
Usage is captured before response validation, including truncated paid outputs.
Observer errors never trigger another paid request.

Use `--rates path/to/rates.json` to estimate cost. `pricing.example.json` is an
intentionally empty template. Supply exact response model IDs, verified official
pricing provenance/date, and USD rates per million tokens:

```json
{
  "source": "https://official-provider.example/pricing",
  "asOf": "YYYY-MM-DD",
  "models": {
    "GEMINI:exact-response-model-id": {
      "inputPerMillion": 0,
      "outputPerMillion": 0,
      "cachedInputPerMillion": 0
    }
  }
}
```

The zeros above illustrate the schema; replace them with verified rates. No
rates are shipped as current prices. Missing model rates, missing usage/cache
metadata, or Claude cache creation leave cost **unavailable** rather than
inventing a price. Gemini output includes total-minus-input tokens so reasoning
is not silently omitted. Subscription discounts, provider free quotas, taxes,
tool charges and hosting are not inferred. Estimates are not invoices.

## Adjudicate before interpreting accuracy

Each run writes `run.json`, `labels.json`, `report.json`, and `report.md`.
For every finding, inspect the trigger and the code in `corpus.json`. Edit
`labels.json`, set `reviewer` and a concrete `rationale`, then choose:

| Verdict | Meaning |
| --- | --- |
| `tp` | Correctly identifies a labelled bug; set its case-local `bugId`. |
| `fp` | Incorrect or unsupported bug claim. |
| `duplicate` | Repeats an already confirmed bug; set the same `bugId`. |
| `additional-tp` | Valid new defect outside labelled ground truth; confirm before counting. |
| `non-bug` | Valid optional style, testing or hardening advice; not a defect claim. |
| `pending` | Not decided. |

Candidate keywords are navigation aids **only**. They never assign true or
false positives. A finding must explain the same failure mechanism; mentioning
"null" or the right filename alone is insufficient. Do not automatically label
all comments on a fixed upstream file false: there may be another real defect.
For publishable claims, use independent reviewers, blind the tool identity, and
resolve disagreements. The checked-in scanner labels are **Codex-assisted**,
not independent human adjudication.

```powershell
npm run benchmark -- --mode score --run .benchmark-runs/gemini-full/run.json --labels .benchmark-runs/gemini-full/labels.json
```

Recall counts unique known bugs per case/repetition. Precision counts confirmed
defect comments; optional advice and duplicates are reported separately. A second
precision measure treats duplicates as noise. Clean-control false-comment rate,
failures, median/p95 time, unknown costs and per-family/category/repetition
metrics are separate. Pending adjudication withholds final recall/precision;
no predictions means precision is unavailable. Repetitions are not independent
new bugs. No significance or production-accuracy claim is implied.

## CodeRabbit comparison

No authenticated CodeRabbit runner is configured in this workspace. The benchmark
does not install an account, publish vulnerable examples, or create upstream PRs.
Use a separate repository you own with an authorized CodeRabbit installation, or
an authenticated CLI, and export the exact same blinded inputs:

```powershell
npm run benchmark -- --mode export --out .benchmark-runs/coderabbit-inputs
```

Keep `mapping.private.json` private and outside the reviewed repository. For each
blind case, create an isolated repository using its `before` tree, commit it,
then apply its `after` tree as the change. Each tree includes the same contract
and related files. Keep third-party license notices. Review the implementation
change only; do not include sibling cases, answers, reports or fixture names.
If the vendor cannot consume identical context/configuration, disclose that
difference. A reconstructed regression PR is not an actual historical PR event.
Record vendor version, plan, configuration, timing boundaries and result URL.

Normalize actual findings into the external schema below; do not run PullPilot's
deduper on competitor output or discard inconvenient comments. Map blind IDs
locally, outside reviewer context. Include every requested case/repetition,
including failures. Use null when cost is unknown.

```json
{
  "corpusSha256": "from mapping.private.json",
  "reviewer": "CodeRabbit / version / plan",
  "timingScope": "end-to-end",
  "scope": "Describe vendor configuration, supplied context, timing and any differences",
  "results": [{
    "caseId": "mapped private case ID",
    "repetition": 1,
    "inputSha256": "from mapping.private.json",
    "status": "ok",
    "durationMs": 1234,
    "costUsd": null,
    "evidenceUrl": "https://your-result-url",
    "findings": [{
      "filePath": "src/change.js",
      "lineNumber": 2,
      "agentType": "BUG",
      "priority": "HIGH",
      "issue": "Exact vendor issue text",
      "suggestion": "Exact vendor remediation text"
    }]
  }]
}
```

```powershell
npm run benchmark -- --mode import --input .benchmark-runs/coderabbit-results.json --out .benchmark-runs/coderabbit
# Adjudicate and score both runs, then compare identical case/repetition hashes:
npm run benchmark -- --mode compare --left .benchmark-runs/gemini-full --right .benchmark-runs/coderabbit --out .benchmark-runs/comparison
```

Different timing scopes are marked noncomparable. CodeRabbit subscription costs
are not equated with marginal model API costs. Absent vendor results provide no
evidence of a competitive advantage.

## Update the corpus deliberately

`npm run benchmark:corpus` rebuilds diffs from local source snapshots using Git.
`npm run benchmark:fetch-prs` explicitly refreshes public snapshots over read-only
GitHub endpoints; normal runs require no GitHub credentials or network. Refreshes
are never automatic. Review changed pins, labels and licenses, then version the
corpus. Old labels/results are rejected against a different corpus hash.

The original 92-case dataset is frozen in `corpora/v1.json`. The earlier
`results/scanner-baseline-v1` remains unchanged and can be rescored explicitly:

```powershell
npm run benchmark -- --mode score --corpus benchmarks/corpora/v1.json --run benchmarks/results/scanner-baseline-v1/run.json --labels benchmarks/results/scanner-baseline-v1/labels.json
```

Do not compare the old 46-bug recall directly with the expanded 96-bug recall;
they use different inputs and denominators. The comparator rejects such runs.
