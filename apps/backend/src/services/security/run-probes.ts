import type { SecurityConfig } from '../config.service';
import { SecurityProbeResult, SecurityCheckRecord, SecurityProbe, checkForProbe } from './probe-types';
import { scanSast } from './probes/sast';
import { scanSecrets } from './probes/secrets';
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
  /** Live advisory database used by the dependency probe; omit to stay offline. */
  osv?: OsvClient;
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

  if (security.sast) {
    results.push(await runSast(diff, options.semgrep));
  }
  if (security.secrets) results.push(scanSecrets(diff));
  if (security.dependencies) results.push(await scanDependencies(diff, { osv: options.osv }));

  const findings = results.flatMap((r) => r.findings);
  const checks = results.flatMap((r) => r.checks);

  const applicable = checks.filter((c) => c.status !== 'SKIPPED');
  return { findings, checks, enabledProbeCount: applicable.length };
}

/**
 * Built-in regex SAST, plus an optional Semgrep pass folded into the same
 * check row so the durable per-probe trail stays at one SAST record.
 */
async function runSast(diff: string, semgrep?: SemgrepOptions): Promise<SecurityProbeResult> {
  const builtIn = scanSast(diff);

  if (semgrep && semgrep.files.size > 0) {
    const extra = await runSemgrep(semgrep);
    if (extra && extra.length > 0) {
      const findings = [...builtIn.findings, ...extra];
      return {
        findings,
        checks: [checkForProbe('SAST', 'sast', 'Static code security scan', findings.length)],
      };
    }
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