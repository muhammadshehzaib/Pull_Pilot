# Prevent credential exposure in built-in SAST findings

## Problem

The built-in SAST probe puts the first 60 characters of a regex match into its
issue text. Basic-auth matches contain reusable encoded credentials, and other
rules can match URLs with passwords or code containing tokens. Truncation does
not remove secrets. The worker stores the issue and the delivery layer copies it
into inline PR comments or the summary fallback, creating another durable leak.

## Implementation plan

1. Stop copying source matches into built-in SAST findings. Build each issue from
   the rule's fixed name and description. Apply this to all built-in SAST rules,
   since credentials can appear inside matches unrelated to authentication.
2. Keep detection patterns, validation, file/line anchors, rule identifiers,
   severity, finding limits, and remediation unchanged. Developers can use the
   cited location to inspect their code without duplicating it in review text.
3. Add regression tests for Basic-auth credentials, credential-bearing URLs,
   long matches, and credentials embedded in other SAST matches. Check serialized
   findings, inline comments, and summary fallback items for raw/encoded secrets.
   Add worker coverage for persisted artifacts and posted comment bodies with
   the AI returning no findings. First reproduce the leaks with the old code.
4. Document the reporting behavior. Run SAST, secrets, probe orchestration,
   finding formatting, and worker tests, then check the final diff.

## Scope and acceptance criteria

- Built-in SAST issue/remediation text contains no copied source matches.
- Credentials in regression fixtures do not appear in stored review results or
  rendered comments, while the same vulnerabilities are still detected.
- Finding locations, severity, and suggested fixes remain available.
- This change protects newly generated built-in SAST findings. It does not
  rewrite existing saved delivery plans or delete old GitHub comments, and does
  not claim to sanitize arbitrary AI or external-scanner output.
