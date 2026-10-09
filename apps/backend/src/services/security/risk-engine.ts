import { AiSuggestion } from '../ai/finding-taxonomy';
import { SecurityProbe } from './probe-types';

/**
 * Risk engine — turns a merged finding list into a single number, verdict and
 * explanation. Purely deterministic: no thresholds live in the config, so the
 * same diff always scores the same.
 *
 * Weights: CRITICAL 30 · HIGH 15 · MEDIUM 6 · LOW 2 · INFO 0, summed and
 * capped at 100. A finding is "blocking" when the whole review should be
 * stopped: any CRITICAL deterministic security finding, a secret finding when
 * the repository's block_on_critical_secret policy is enabled, or a total
 * score of 75+.
 */

export type RiskVerdict = 'BLOCK' | 'REVIEW' | 'SAFE';

export interface RiskReport {
  score: number;
  verdict: RiskVerdict;
  blockingCount: number;
  securityFindingCount: number;
  corroboratedCount: number;
  categories: string[];
  byProbe: Record<SecurityProbe, number>;
  reasons: string[];
}

export interface RiskOptions {
  /** Whether a deterministic critical secret finding should force BLOCK. */
  blockOnCriticalSecret?: boolean;
}

export const SEVERITY_WEIGHTS = { CRITICAL: 30, HIGH: 15, MEDIUM: 6, LOW: 2, INFO: 0 } as const;

/** Distance (in lines, same file) inside which a deterministic finding and a model finding are "corroborated". */
export const CORROBORATION_WINDOW = 5;

const PROBE_SOURCES: AiSuggestion['source'][] = ['SAST', 'SECRETS', 'DEPENDENCIES'];

/**
 * Computes the risk report for a merged finding list and annotates every
 * candidate with `corroborated` when a deterministic finding lines up with a
 * model (or rules) finding on the same file within the window.
 *
 * The input list should already be deduplicated; otherwise the same defect
 * reported twice would count twice toward the score.
 */
export function assessRisk(
  findings: AiSuggestion[],
  options: RiskOptions = {},
): { report: RiskReport; findings: AiSuggestion[] } {
  const annotated = findings.map((f) => ({ ...f }));

  const probeFindings = annotated.filter((f) => f.source && PROBE_SOURCES.includes(f.source));
  const otherFindings = annotated.filter((f) => !f.source || !PROBE_SOURCES.includes(f.source));

  let corroboratedCount = 0;
  for (const probe of probeFindings) {
    const match = otherFindings.some((o) => {
      if (o.filePath !== probe.filePath) return false;
      return Math.abs((o.lineNumber ?? 1) - (probe.lineNumber ?? 1)) <= CORROBORATION_WINDOW;
    });
    if (match) {
      probe.corroborated = true;
      corroboratedCount += 1;
    }
  }

  const byProbe: Record<SecurityProbe, number> = { SAST: 0, SECRETS: 0, DEPENDENCIES: 0 };
  const securityFindings = probeFindings;
  for (const f of securityFindings) {
    if (f.source === 'SECRETS') byProbe.SECRETS += 1;
    else if (f.source === 'DEPENDENCIES') byProbe.DEPENDENCIES += 1;
    else if (f.source === 'SAST') byProbe.SAST += 1;
  }

  let score = 0;
  for (const f of annotated) score += SEVERITY_WEIGHTS[f.priority] ?? 0;
  score = Math.min(score, 100);

  const blockOnCriticalSecret = options.blockOnCriticalSecret ?? true;
  const hasCriticalSecurity = securityFindings.some(
    (f) => f.priority === 'CRITICAL' && (f.source !== 'SECRETS' || blockOnCriticalSecret),
  );
  const hasSecret = blockOnCriticalSecret && securityFindings.some((f) => f.source === 'SECRETS');
  const hasHigh = findings.some((f) => f.priority === 'HIGH');

  const reasons: string[] = [];
  if (hasCriticalSecurity) reasons.push('Critical security finding detected');
  if (hasSecret) reasons.push('Hardcoded credential(s) detected');
  if (score >= 75) reasons.push(`Risk score ${score}/100 at or above the blocking threshold`);
  if (hasHigh) reasons.push('High-severity finding requires attention');
  if (reasons.length === 0 && findings.length > 0) {
    reasons.push(`${findings.length} non-blocking finding(s) to review`);
  }
  if (corroboratedCount > 0) {
    reasons.push(`${corroboratedCount} finding(s) corroborated by a deterministic scan`);
  }

  let verdict: RiskVerdict;
  if (hasCriticalSecurity || hasSecret || score >= 75) verdict = 'BLOCK';
  else if (score >= 25 || hasHigh) verdict = 'REVIEW';
  else verdict = 'SAFE';

  const categories = Array.from(new Set(annotated.map((f) => f.agentType)));

  const report: RiskReport = {
    score,
    verdict,
    blockingCount: score >= 75
      ? securityFindings.length
      : securityFindings.filter((f) =>
          f.source === 'SECRETS'
            ? blockOnCriticalSecret
            : f.priority === 'CRITICAL',
        ).length,
    securityFindingCount: securityFindings.length,
    corroboratedCount,
    categories,
    byProbe,
    reasons,
  };

  return { report, findings: annotated };
}
