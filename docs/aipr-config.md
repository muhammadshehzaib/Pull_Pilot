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

## Notes

- `summarize: false` suppresses the top-level PR summary comment. Inline findings
  are unaffected.
- A finding the model labels with an unrecognised severity is treated as `info`
  rather than discarded, so raising `min_severity` can never silently hide a real
  issue.
- If an inline comment is rejected (for example, the cited line is not part of
  the diff), the finding is still included in the PR summary and saved to the
  dashboard. The job result records it under `commentFailures`.