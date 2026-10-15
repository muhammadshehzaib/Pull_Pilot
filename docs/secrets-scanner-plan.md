# Scan secrets in comments and beside suppression text

## Problem

The secrets probe skips every added line beginning with `#`, `//`, `*`, or `/*`.
It also skips lines containing the words `disable`, `noprotect`, or `noinspection`.
A contributor can therefore hide a credential in a comment or append an unrelated
linter directive to a credential assignment to avoid detection.

## Implementation plan

1. Remove the comment/suppression line filter. Apply the existing secret rules to
   every added line in the diff, including comments. Do not introduce a new inline
   suppression directive.
2. Preserve the existing provider patterns, generic candidate validation,
   placeholder and hash exclusions, finding limits, severity, and redaction.
   Continue scanning added lines only, within the existing configured file scope.
3. Replace the test that expects comments to be skipped. Add regression coverage
   for provider tokens and generic secret assignments in each formerly skipped
   comment form and beside suppression words/directives. Verify correct locations,
   failing probe status, and absence of raw credentials in serialized findings.
   Check harmless comments, placeholders, and unchanged/deleted secrets too.
4. Document that comments and unrelated tool directives do not suppress credential
   scanning. Run the regression tests against the old implementation to confirm
   the bypass, then run the secrets, probe orchestration, and worker tests after
   the fix. Check the final diff for whitespace errors.

## Acceptance criteria

- A GitHub token followed by `// eslint-disable-line` produces a redacted finding.
- Recognized secrets in added comments produce findings.
- Suppression words do not hide provider tokens or generic secret assignments.
- Existing candidate validation, redaction, and added-line scope still apply.
