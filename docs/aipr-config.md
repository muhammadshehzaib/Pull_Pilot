# Repository configuration (`.aipr.yml`)

Drop a `.aipr.yml` at the repo root and the reviewer picks it up automatically.
It is read from `.aipr.yml`, `.aipr.yaml`, `.github/.aipr.yml`, or `.github/.aipr.yaml`.

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

## `security`

The deterministic security layer. Three probes run against the **filtered
diff** before the model is ever called — no LLM judgement involved — and a risk
engine combines their findings with the model's into a single score and verdict.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the whole security layer. `false` skips every probe. |
| `sast` | `true` | Static analysis patterns — SQL injection, `exec`/`spawn` misuse, XSS sinks, SSRF, auth bypass, open redirects. |
| `secrets` | `true` | Credential scan — API keys, tokens, JWT signatures, connection strings; reported redacted. |
| `dependencies` | `true` | Advisory lookup for new/changed dependency ranges across `package.json`, `requirements*.txt`, `go.mod`, and `Gemfile`. |
| `block_on_critical_secret` | `true` | When a hardcoded credential is found, the review verdict is `BLOCK`. |

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

## Notes

- `summarize: false` suppresses the top-level PR summary comment. Inline findings
  are unaffected.
- A finding the model labels with an unrecognised severity is treated as `info`
  rather than discarded, so raising `min_severity` can never silently hide a real
  issue.
- If an inline comment is rejected (for example, the cited line is not part of
  the diff), the finding is still included in the PR summary and saved to the
  dashboard. The job result records it under `commentFailures`.