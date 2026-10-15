# Scanner execution limits

Before diff parsing/filtering in the review worker, input is bounded to one
million characters and 10,000 physical lines. Lines longer than 2,048 source
characters are omitted, retaining their diff prefix as a line-number placeholder.
Truncated source is never treated as a plausible complete line. A review with no
usable input is skipped with an explicit safety-limit reason.

The built-in SAST and secrets probes also apply these guards when called directly.
Production orchestration runs each probe in its own Node worker thread, with a
five-second execution deadline and a 128 MiB old-generation heap budget. Timeout,
crash, missing module, or memory failure produces DEGRADED coverage, never PASS.
The thread is terminated after success or failure. Only trusted scanner modules
execute; customer diff content is worker data, never a script or module path.

The deployment uses compiled JavaScript modules. Source/test execution uses a
TypeScript loader inside the isolated thread; no customer-controlled loader or
path is accepted. Tests terminate a real infinite-loop thread and verify that
the parent remains responsive.

Dependency scanning receives the same bounded diff. External Semgrep already
has its own process timeout; incomplete built-in coverage is preserved even when
Semgrep runs successfully. Findings from checked lines are retained. Checks carry
an explicit omission notice, and risk coverage remains PARTIAL even if a checked
line produced a finding. Rules on an incomplete review are marked SKIPPED because
the whole selected input was not checked.

These limits intentionally reduce automated coverage for minified/generated or
very large changes. Split such changes or inspect omitted content separately.
They protect availability; they do not certify omitted code as safe.
