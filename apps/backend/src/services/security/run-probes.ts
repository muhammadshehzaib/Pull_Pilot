import type { SecurityConfig } from '../config.service';
import { SecurityProbeResult, SecurityCheckRecord, SecurityProbe } from './probe-types';
import { scanSast } from './probes/sast';
import { scanSecrets } from './probes/secrets';
import { scanDependencies } from './probes/deps';
import type { SecuritySuggestion } from './probe-types';

export interface SecurityScanOutcome {
  findings: SecuritySuggestion[];
  checks: SecurityCheckRecord[];
  /** Number of probes that actually ran (enabled AND applicable to the diff). */
  enabledProbeCount: number;
}

/**
 * Runs the enabled deterministic security probes over a filtered diff.
 *
 * Order matters for stable output: SAST first, then secrets, then
 * dependencies. Each probe produces its own check row so the job detail page
 * can show per-probe PASS/FAIL.
 */
export function runSecurityProbes(security: SecurityConfig, diff: string): SecurityScanOutcome {
  if (!security.enabled) return { findings: [], checks: [], enabledProbeCount: 0 };

  const results: SecurityProbeResult[] = [];
  if (security.sast) results.push(scanSast(diff));
  if (security.secrets) results.push(scanSecrets(diff));
  if (security.dependencies) results.push(scanDependencies(diff));

  const findings = results.flatMap((r) => r.findings);
  const checks = results.flatMap((r) => r.checks);

  const applicable = checks.filter((c) => c.status !== 'SKIPPED');
  return { findings, checks, enabledProbeCount: applicable.length };
}

/** Group counts by probe for the socket/log line. */
export function countByProbe(findings: SecuritySuggestion[]): Record<SecurityProbe, number> {
  const counts: Record<SecurityProbe, number> = { SAST: 0, SECRETS: 0, DEPENDENCIES: 0 };
  for (const f of findings) counts[f.source] = (counts[f.source] ?? 0) + 1;
  return counts;
}