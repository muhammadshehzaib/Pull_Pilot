import type { SecurityConfig } from '../config.service';
import { SecurityProbeResult, SecurityCheckRecord, SecurityProbe, checkForProbe, checkForProbeWithStatus } from './probe-types';
import { runIsolatedProbe } from './isolated-probe';
import { boundScanInput, INCOMPLETE_SCAN } from './scan-input';
import { scanDependencies } from './probes/deps';
import type { SecuritySuggestion } from './probe-types';
import type { OsvClient } from './osv-client';
import { runSemgrep, type SemgrepOptions } from './semgrep.service';

export interface SecurityScanOutcome {
  findings: SecuritySuggestion[];
  checks: SecurityCheckRecord[];
  /** Number of probes that actually ran (enabled AND applicable to the diff). */
  enabledProbeCount: number;
}

export interface SecurityProbeOptions {
  /** Trusted pipeline notice when earlier diff filtering omitted oversized input. */
  inputDetail?: string;
  /** Live advisory database used by the dependency probe; omit to stay offline. */
  osv?: OsvClient;
  /** Unfiltered GitHub diff for scanning lockfiles omitted from the AI review diff. */
  dependencyDiff?: string;
  /** When present, Semgrep runs as an extra SAST pass over the supplied files. */
  semgrep?: SemgrepOptions;
}

/**
 * Runs the enabled deterministic security probes over a filtered diff.
 *
 * Order matters for stable output: SAST first, then secrets, then
 * dependencies. Each probe produces its own check row so the job detail page
 * can show per-probe PASS/FAIL.
 *
 * Async because two external integrations can engage: the dependency probe
 * consults OSV.dev, and SAST can add a Semgrep pass. Both degrade gracefully —
 * a network outage or a missing binary leaves the other probes untouched.
 */
export async function runSecurityProbes(
  security: SecurityConfig,
  diff: string,
  options: SecurityProbeOptions = {},
): Promise<SecurityScanOutcome> {
  if (!security.enabled) return { findings: [], checks: [], enabledProbeCount: 0 };

  const results: SecurityProbeResult[] = [];
  const input = boundScanInput(diff);
  const dependencyInput = boundScanInput(options.dependencyDiff ?? diff);

  if (security.sast) {
    results.push(await runSast(input.diff, options.semgrep));
  }
  if (security.secrets) results.push(await runIsolatedProbe('secrets', input.diff));
  if (security.dependencies) {
    results.push(await scanDependencies(input.diff, {
      osv: options.osv,
      lockfileDiff: dependencyInput.diff,
    }));
  }

  const findings = results.flatMap((r) => r.findings);
  const checks = results.flatMap((r) => r.checks);
  const detail = options.inputDetail || (input.incomplete || dependencyInput.incomplete ? INCOMPLETE_SCAN : undefined);
  if (detail) for (const check of checks) {
    if (check.status !== 'FAIL') check.status = 'DEGRADED';
    check.detail = [check.detail, detail].filter(Boolean).join(' ');
  }

  const applicable = checks.filter((c) => c.status !== 'SKIPPED');
  return { findings, checks, enabledProbeCount: applicable.length };
}

/**
 * Built-in regex SAST, plus an optional Semgrep pass folded into the same
 * check row so the durable per-probe trail stays at one SAST record.
 *
 * When the optional pass was requested but could not run, the row becomes
 * DEGRADED (or FAIL if the built-in rules still flagged something) with the
 * Semgrep reason in `detail` — an unavailable scanner must never read as a
 * clean, full-coverage scan.
 */
async function runSast(diff: string, semgrep?: SemgrepOptions): Promise<SecurityProbeResult> {
  const builtIn = await runIsolatedProbe('sast', diff);

  if (semgrep && semgrep.files.size > 0) {
    const extra = await runSemgrep(semgrep);
    if (extra.degraded) {
      return {
        findings: builtIn.findings,
        checks: [
          checkForProbeWithStatus(
            'SAST',
            'sast',
            'Static code security scan',
            'DEGRADED',
            builtIn.findings.length,
            [`Semgrep extra pass skipped: ${extra.reason}.`, builtIn.checks[0]?.detail].filter(Boolean).join(' '),
          ),
        ],
      };
    }
    const findings = [...builtIn.findings, ...extra.findings];
    return {
      findings,
      checks: [builtIn.checks[0]?.detail
        ? checkForProbeWithStatus('SAST', 'sast', 'Static code security scan', 'DEGRADED', findings.length, builtIn.checks[0].detail)
        : checkForProbe('SAST', 'sast', 'Static code security scan', findings.length)],
    };
  }

  return builtIn;
}

/** Counts findings per probe, for logging and the summary line. */
export function countByProbe(findings: SecuritySuggestion[]): Record<SecurityProbe, number> {
  const byProbe: Record<SecurityProbe, number> = { SAST: 0, SECRETS: 0, DEPENDENCIES: 0 };
  for (const finding of findings) {
    byProbe[finding.source] += 1;
  }
  return byProbe;
}
