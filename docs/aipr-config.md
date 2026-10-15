# Repository configuration (`.aipr.yml`)

Drop a `.aipr.yml` at the repo root and the reviewer picks it up automatically.
It is read from `.aipr.yml`, `.aipr.yaml`, `.github/.aipr.yml`, or `.github/.aipr.yaml`.

For pull requests, configuration is read from the target repository at the PR's
base commit. Changes to these files in a PR cannot change its own ignore patterns,
security settings, or AI guidelines. They take effect for subsequent reviews after
being merged. If the base commit has no configuration file, the reviewer uses its
defaults. Push reviews read configuration from the pushed commit.

## Example

```yaml
version: 1

# Only report findings at or above this level.
# One of: info | low | medium | high | critical  (case-insensitive)
min_severity: medium

# Never review these paths.
ignore:
  - "dist/**"
  - "package-lock.json"
  - "**/*.snap"

# Extra instructions handed to the model for this repository.
guidelines:
  - "Never log secrets or PII"
  - "All public functions must have explicit return types"
  - "Database access must go through the repository layer"

# Codebase context engine: how much related code to fetch around the diff.
context:
  enabled: true
  max_hops: 2
  max_files: 25
  max_tokens: 30000

# Deterministic security layer: pattern scans + advisory lookups that run
# before the model and combine into a risk score that can block a review.
security:
  enabled: true
  sast: true
  secrets: true
  dependencies: true
  osv: true
  semgrep: false
  block_on_critical_secret: true

language: en
summarize: true
```

## `min_severity`

Findings below the threshold are dropped before anything is posted. Levels, lowest
to highest:

| Level | Meaning |
|---|---|
| `info` | Informational only. Show everything. |
| `low` | **Default.** Drops `info`. |
| `medium` | Real problems worth fixing. |
| `high` | Bugs and vulnerabilities that affect users. |
| `critical` | Exploitable vulnerabilities, data loss, or crashes. |

Unrecognised values fall back to the default and log a warning — they are not
silently ignored.

## Finding categories

Every finding is tagged with one of these:

| Category | Covers |
|---|---|
| `SECURITY` | Injection, authn/authz, secrets, SSRF, XSS, crypto misuse |
| `BUG` | Runtime misbehaviour — null dereference, wrong condition, off-by-one |
| `CORRECTNESS` | Logic that is wrong but does not immediately crash |
| `PERFORMANCE` | Slow paths, N+1 queries, leaks, event-loop blocking |
| `ARCHITECTURE` | Coupling, layering, unclear boundaries |
| `MAINTAINABILITY` | Dead code, duplication, naming, missing types |
| `TESTING` | Missing or weak coverage for the changed behaviour |

## `context`

Controls the **codebase context engine** — instead of reviewing the diff in
isolation, the reviewer builds an import/dependency graph from the repository
tree, walks it outward from the changed files, and sends the related files
(callers, callees, tests) to the model alongside the diff.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to fall back to diff-only reviews. |
| `max_hops` | `2` | Graph-walk depth from each changed file. |
| `max_files` | `25` | Maximum related files included in the prompt. |
| `max_tokens` | `30000` | Token ceiling for the context block (excluding the diff). |

Values are **clamped to platform ceilings** (`CONTEXT_MAX_HOPS/FILES/TOKENS`
env vars) — a repository may reduce its budget or disable context, but cannot
raise it above what the deployment allows. Malformed values fall back to
defaults.

Import discovery now inspects eligible unchanged files too, so incoming callers
and their tests can be found even when they are absent from the PR diff. Parsed
imports are encrypted and cached by repository/blob/parser version. Indexing has
separate deployment-controlled file/download/byte/time limits; it does not send
the whole index to the model. Reviews persist complete/partial/unavailable
discovery metadata even when no background files are selected. See
[context discovery](context-discovery.md) for configuration and limitations.

## `security`

The deterministic security layer. Three probes run against the **filtered
diff** before the model is ever called — no LLM judgement involved — and a risk
engine combines their findings with the model's into a single score and verdict.
Two probes can delegate to real external scanners instead of hand-rolled rules:
dependencies to **OSV.dev**, and SAST to **Semgrep** (opt-in).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the whole security layer. `false` skips every probe. |
| `sast` | `true` | Static analysis patterns — SQL injection, command execution, XSS sinks, SSRF, unsafe file paths, insecure auth patterns, disabled TLS verification, weak hashes, unsafe Python pickle loading, and open redirects. |
| `secrets` | `true` | Credential scan — API keys, tokens, JWT signatures, connection strings; reported redacted. |
| `dependencies` | `true` | Advisory lookup for new/changed dependency ranges in `package.json`, `requirements*.txt`, `go.mod`, and `Gemfile`, plus newly resolved exact versions in lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` (npm), `go.sum` (Go), `Gemfile.lock` (RubyGems), `Cargo.lock` (crates.io), and `poetry.lock` (PyPI) — including transitive packages. |
| `osv` | `true` | Query the live OSV.dev advisory database for dependencies. When off — or unreachable — the probe falls back to a small bundled offline registry. |
| `semgrep` | `false` | Run the external **Semgrep** scanner as an extra SAST pass. Requires the `semgrep` binary; when it is absent the SAST probe is marked `DEGRADED` and the built-in rules still run. |
| `block_on_critical_secret` | `true` | When a hardcoded credential is found, the review verdict is `BLOCK`. |

The secrets probe checks added lines in included files, including comments.
Words such as `disable`, `noprotect`, and `noinspection`, and unrelated directives
such as `eslint-disable-line`, do not suppress credential scanning. Recognized
credentials are reported with redacted values. Existing generic-secret checks
still exclude recognizable placeholders, pure hex values, and low-entropy values.

Built-in SAST findings use fixed rule explanations and remediation text rather
than quoting matched source code, which may contain passwords or tokens. File and
line references still identify the affected code. This applies to newly generated
findings; existing saved review plans and previously posted comments are not
rewritten. AI and external-scanner output are separate from this reporting rule.

**Probe statuses.** Each probe records one durable outcome per job. The
dashboard renders the status verbatim, and a status is never upgraded to a clean
pass when coverage was partial:

| Status | Meaning |
|---|---|
| `PASS` | The probe ran with full coverage and found nothing. |
| `FAIL` | The probe found at least one issue (for dependencies, a known-vulnerable package; informational "introduced"/"major bump" notes do not count). |
| `SKIPPED` | The probe had nothing applicable to scan — e.g. no supported manifests or lockfiles changed. |
| `DEGRADED` | The probe ran with **reduced coverage**: the optional Semgrep pass was unavailable, or the live OSV.dev lookup could not answer for some packages and the bundled offline registry filled the gaps. `detail` explains the reduction. |

**External scanners.** Dependencies are checked against [OSV.dev](https://osv.dev)
using the minimum selectable version implied by each manifest constraint (and the
exact resolved version from a lockfile). A range that could resolve to a
vulnerable release is flagged. If OSV is disabled, unreachable, or only partly
available, the built-in advisory registry covers the gaps and the probe is
reported `DEGRADED` rather than `PASS`, so a partial scan is never mistaken for a
clean one. Semgrep is opt-in because it needs the `semgrep` binary on the host
(`pip install semgrep`); when present it scans the changed files' full contents
and its findings are folded into the SAST probe. The tunables (`OSV_API_URL`,
`OSV_QUERY_TIMEOUT_MS`, `OSV_MAX_BATCH`, `SEMGREP_BIN`, `SEMGREP_RULES`,
`SEMGREP_TIMEOUT_MS`) live in the backend environment.

Lockfiles remain excluded from the AI prompt by default; the dependency security
probe still inspects their changed package/version entries even when the review's
`ignore` patterns exclude them from the model diff. Findings are deduplicated by
package/version/advisory, so a manifest range and its lockfile resolution do not
double-count the same advisory, and the probe stays bounded (a capped number of
lockfiles, candidates, and per-rule findings).

**Limitations.** The dependency probe only proposes packages whose version the
diff actually *adds*; removals and unchanged entries are not re-audited. Lockfile
parsers are best-effort over added lines and cover the formats listed above — an
unsupported ecosystem is not scanned and yields a `SKIPPED` (or the manifest-only
path). The bundled offline registry is deliberately small; it is a fallback for
network outages, not a replacement for OSV.

The risk engine scores every finding (info `0`, low `2`, medium `6`, high `15`,
critical `30`, capped at `100`) and picks a verdict:

| Verdict | Condition |
|---|---|
| `BLOCK` | Any critical security finding, any hardcoded credential, or `score >= 75` |
| `REVIEW` | `score >= 25` or any high-severity finding |
| `SAFE` | Everything below that |

A `BLOCK` verdict still posts the review (findings and summary) but marks the
PR merge-blocked in the dashboard. Deterministic findings always bypass
`min_severity` — the security layer is not quietly optional behind a repo-wide
threshold.

## Test-gap analysis

After the security layer runs, the reviewer makes one extra, best-effort pass
over the changed source files to suggest tests the change may be missing. It is
always on (there is no `.aipr.yml` switch) because it is advisory and cannot
affect the review's verdict or block a merge.

Before asking the model, discovery does pure path matching: changed files that
look like code under test are compared against existing test files by naming
convention (`*.test.*`, `*_test.go`, `test_*.py`, `*_Test.java`, `tests/`
directories, and similar), and a bounded number of source and test excerpts are
read. The model is then asked only for genuinely missing scenarios — edge cases,
error paths, boundary and invalid input, and security-relevant inputs — and may
cite only the changed source files it was given.

Properties and limitations:

- Nothing is executed. Suggested tests are text only; no code runs, no files
  are written, and the repository is never modified.
- The report is advisory. It never changes the risk score or verdict, and it is
  stored on the job under `metadata.testGaps` rather than in the findings list.
- It is bounded and best-effort: scenarios are capped, excerpts are truncated,
  and the step silently disappears if the provider does not support it or the
  model call fails.
- The evidence records whether the repository view was partial (a missing or
  truncated tree listing, or a file that could not be read), so an empty result
  is never mistaken for proof of coverage. Absence of suggestions is not a claim
  of exhaustive test coverage.

## Notes

- `summarize: false` suppresses the top-level PR summary comment. Inline findings
  are unaffected.
- A finding the model labels with an unrecognised severity is treated as `info`
  rather than discarded, so raising `min_severity` can never silently hide a real
  issue.
- If an inline comment is rejected (for example, the cited line is not part of
  the diff), the finding is still included in the PR summary and saved to the
  dashboard. The job result records it under `commentFailures`.
