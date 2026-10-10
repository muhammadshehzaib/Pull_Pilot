import { AiSuggestion } from '../ai/finding-taxonomy';
import { SecurityProbe } from './probe-types';
import type { SecurityCheckRecord } from './probe-types';
import type { BehavioralReport } from '../behavioral/contracts';
import type { TestGapReport } from '../test-gap/test-gap-types';
import type { RuleCheckRecord } from '../rules.service';
import { createHash } from 'node:crypto';

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

export const RISK_V2_THRESHOLDS = { review: 25, block: 75 } as const;
export interface RiskFactor {
  id: string;
  kind: 'FINDING' | 'TEST_GAP' | 'BEHAVIORAL_FAILURE' | 'RULE_FAILURE';
  points: number;
  filePath?: string;
  lineNumber?: number;
  sources: string[];
  corroborated: boolean;
  explanation: string;
}
export interface ExplainableRiskReport extends RiskReport {
  version: 2;
  direction: 'HIGHER_IS_RISKIER';
  enforcement: 'ADVISORY';
  thresholds: typeof RISK_V2_THRESHOLDS;
  unclampedScore: number;
  factors: RiskFactor[];
  factorsOmitted: number;
  duplicateCount: number;
  coverage: {
    scope: 'CHANGED_FILES_ONLY';
    includedFiles: number;
    ignoredFiles: number;
    security: Record<SecurityProbe, 'FULL' | 'PARTIAL' | 'NOT_RUN'>;
    rules: { executed: number; failed: number; skipped: number };
    context: 'AVAILABLE' | 'PARTIAL' | 'NOT_RUN';
    testGaps: 'AVAILABLE' | 'PARTIAL' | 'NOT_RUN';
    behavioral: { generated: number; executed: number; verified: number; failed: number; notRun: number; timedOut: number; errors: number };
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    missingEvidence: string[];
  };
}
export interface ExplainableRiskOptions extends RiskOptions {
  securityChecks?: SecurityCheckRecord[];
  ruleChecks?: Pick<RuleCheckRecord, 'ruleId' | 'status' | 'violationCount'>[];
  includedFiles?: string[];
  ignoredFiles?: string[];
  context?: 'AVAILABLE' | 'PARTIAL' | 'NOT_RUN';
  testGaps?: TestGapReport | null;
  behavioral?: BehavioralReport;
}
const riskId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);
const issueKey = (issue: string) => issue.trim().toLowerCase().replace(/\s+/g, ' ');
const findingKey = (f: AiSuggestion) => JSON.stringify([f.filePath.replace(/\\/g, '/').replace(/^\.\//, ''), f.lineNumber, f.agentType, issueKey(f.issue)]);

/** V2 is additive to the legacy report, with no subtraction for missing scans or CI. */
export function assessExplainableRisk(input: AiSuggestion[], options: ExplainableRiskOptions = {}): ExplainableRiskReport {
  const groups = new Map<string, AiSuggestion>();
  for (const finding of input) {
    const key = findingKey(finding);
    const previous = groups.get(key);
    const sources = Array.from(new Set([...(previous?.sources ?? (previous ? [previous.source ?? 'LLM'] : [])), ...(finding.sources ?? [finding.source ?? 'LLM'])]));
    const strongest = previous && SEVERITY_WEIGHTS[previous.priority] > SEVERITY_WEIGHTS[finding.priority] ? previous : finding;
    groups.set(key, { ...strongest, sources, ruleKeys: Array.from(new Set([...(previous?.ruleKeys ?? []), ...(finding.ruleKeys ?? [])])) });
  }
  const findings = [...groups.values()];
  const factors: RiskFactor[] = findings.map(f => {
    const sources = f.sources ?? [f.source ?? 'LLM'];
    const corroborated = sources.some(s => PROBE_SOURCES.includes(s as AiSuggestion['source'])) && sources.some(s => s === 'LLM' || s === 'RULES');
    return { id: riskId(findingKey(f)), kind: 'FINDING', points: SEVERITY_WEIGHTS[f.priority], filePath: f.filePath.slice(0, 300), lineNumber: f.lineNumber, sources, corroborated, explanation: `${f.priority} ${f.agentType} finding; strongest severity counted once${corroborated ? ', corroborated detection adds no extra points' : ''}.` };
  });
  const behavior = options.behavioral?.scenarios ?? [];
  const seenGaps = new Set<string>();
  for (const gap of options.testGaps?.scenarios ?? []) {
    const key = JSON.stringify([gap.filePath, gap.lineNumber, issueKey(gap.scenario)]);
    if (seenGaps.has(key)) continue;
    seenGaps.add(key);
    const execution = behavior.find(s => s.filePath === gap.filePath && s.description === gap.scenario.slice(0, 300));
    const failed = execution?.lastAssertionStatus === 'FAILED' || execution?.status === 'FAILED' && execution.stage === 'EXECUTED';
    const verified = execution?.status === 'PASSED' && execution.stage === 'VERIFIED';
    // If a finding describes this exact scenario, use the stronger indication
    // once. Never guess that nearby but differently named defects are duplicates.
    const sameFinding = findings.find(f => f.filePath === gap.filePath && f.lineNumber === gap.lineNumber && issueKey(f.issue) === issueKey(gap.scenario));
    const existing = sameFinding ? factors.find(f => f.id === riskId(findingKey(sameFinding))) : undefined;
    const points = verified ? 0 : failed ? 15 : gap.confidence === 'HIGH' ? 2 : gap.confidence === 'MEDIUM' ? 1 : 0;
    if (existing) {
      if (failed) { existing.points = Math.max(existing.points, points); existing.sources.push('OWNER_CI'); existing.corroborated = true; existing.explanation += ' Executed assertion failure corroborates this defect; strongest indication counted once.'; }
      continue;
    }
    factors.push({ id: riskId(key), kind: failed ? 'BEHAVIORAL_FAILURE' : 'TEST_GAP', points, filePath: gap.filePath.slice(0, 300), lineNumber: gap.lineNumber, sources: failed ? ['OWNER_CI'] : ['TEST_GAP'], corroborated: false, explanation: verified ? 'Explicit scenario verified in owner CI; no advisory gap points for this scenario.' : failed ? 'Explicit assertion failed in owner CI (+15); not counted again as an advisory gap. A later missing/error run cannot erase that failure.' : `Advisory ${gap.confidence.toLowerCase()}-confidence gap (+${points}); generated tests and unexecuted scenarios do not establish a failure or a pass.` });
  }
  for (const s of behavior) {
    if (!(s.lastAssertionStatus === 'FAILED' || s.status === 'FAILED' && s.stage === 'EXECUTED') || (options.testGaps?.scenarios ?? []).some(g => g.filePath === s.filePath && g.scenario.slice(0, 300) === s.description)) continue;
    factors.push({ id: riskId(`behavior:${s.id}`), kind: 'BEHAVIORAL_FAILURE', points: 15, filePath: s.filePath.slice(0, 300), sources: ['OWNER_CI'], corroborated: false, explanation: 'Executed owner-CI assertion failure (+15); source test-gap metadata is unavailable.' });
  }
  const ruleChecks = options.ruleChecks ?? [];
  const failedRules = ruleChecks.filter(c => c.status === 'FAIL');
  for (const rule of failedRules) {
    const represented = findings.some(f => f.ruleKeys?.includes(rule.ruleId) || ((f.sources?.includes('RULES') || f.source === 'RULES') && !f.ruleKeys?.length));
    if (!represented) factors.push({ id: riskId(`rule:${rule.ruleId}`), kind: 'RULE_FAILURE', points: 6, sources: ['RULES'], corroborated: false, explanation: 'Failed deterministic rule check without a corresponding finding (+6); inspect rule history.' });
  }
  const byProbe = { SAST: 0, SECRETS: 0, DEPENDENCIES: 0 };
  const securityFindings = findings.filter(f => f.sources?.some(s => PROBE_SOURCES.includes(s)));
  for (const f of securityFindings) for (const probe of ['SAST', 'SECRETS', 'DEPENDENCIES'] as const) if (f.sources?.includes(probe)) byProbe[probe]++;
  const policy = options.blockOnCriticalSecret ?? true;
  const criticalSecurity = securityFindings.filter(f => f.priority === 'CRITICAL' && f.sources?.some(s => s === 'SAST' || s === 'DEPENDENCIES' || (s === 'SECRETS' && policy)));
  const secrets = policy ? securityFindings.filter(f => f.sources?.includes('SECRETS')) : [];
  const unclampedScore = factors.reduce((n, f) => n + f.points, 0);
  const score = Math.min(100, unclampedScore);
  const behavioralFailures = behavior.filter(s => s.lastAssertionStatus === 'FAILED' || s.status === 'FAILED' && s.stage === 'EXECUTED').length;
  const hasHigh = findings.some(f => f.priority === 'HIGH' || f.priority === 'CRITICAL');
  const verdict: RiskVerdict = criticalSecurity.length || secrets.length || score >= RISK_V2_THRESHOLDS.block ? 'BLOCK' : score >= RISK_V2_THRESHOLDS.review || hasHigh || behavioralFailures || failedRules.length ? 'REVIEW' : 'SAFE';
  const reasons = [
    ...(criticalSecurity.length ? ['Critical deterministic security finding detected.'] : []),
    ...(secrets.length ? ['Credential findings trigger the configured advisory BLOCK policy.'] : []),
    ...(score >= RISK_V2_THRESHOLDS.block ? [`Score reaches the ${RISK_V2_THRESHOLDS.block} BLOCK threshold.`] : []),
    ...(hasHigh ? ['High or critical severity findings require review.'] : []),
    ...(behavioralFailures ? [`${behavioralFailures} executed behavioral assertion failure(s).`] : []),
    ...(failedRules.length ? [`${failedRules.length} failed repository rule check(s).`] : []),
    '0 indicates lower risk; 100 indicates higher risk based on the available evidence.',
    'Verdicts are advisory; no GitHub merge protection is enforced by this report.',
  ];
  const security: ExplainableRiskReport['coverage']['security'] = { SAST: 'NOT_RUN', SECRETS: 'NOT_RUN', DEPENDENCIES: 'NOT_RUN' };
  for (const probe of Object.keys(security) as SecurityProbe[]) {
    const checks = (options.securityChecks ?? []).filter(c => c.probe === probe);
    if (checks.length) security[probe] = checks.every(c => ['PASS', 'FAIL'].includes(c.status) && !c.detail) ? 'FULL' : checks.every(c => c.status === 'SKIPPED') ? 'NOT_RUN' : 'PARTIAL';
  }
  const missingEvidence: string[] = [];
  for (const probe of Object.keys(security) as SecurityProbe[]) if (security[probe] !== 'FULL') missingEvidence.push(`${probe}: ${security[probe].toLowerCase()} coverage`);
  const context = options.context ?? 'NOT_RUN';
  if (context !== 'AVAILABLE') missingEvidence.push(`Context: ${context.toLowerCase()}`);
  const testGaps = options.testGaps?.analyzed ? !options.testGaps.evidence || options.testGaps.evidence.incomplete || options.testGaps.evidence.treeTruncated ? 'PARTIAL' : 'AVAILABLE' : 'NOT_RUN';
  if (testGaps !== 'AVAILABLE') missingEvidence.push(`Test-gap analysis: ${testGaps.toLowerCase()}`);
  const behavioral = { generated: behavior.length, executed: behavior.filter(s => s.stage === 'EXECUTED' || s.stage === 'VERIFIED').length, verified: behavior.filter(s => s.status === 'PASSED' && s.stage === 'VERIFIED').length, failed: behavioralFailures, notRun: behavior.filter(s => s.status === 'NOT_RUN').length, timedOut: behavior.filter(s => s.status === 'TIMED_OUT').length, errors: behavior.filter(s => s.status === 'ERROR').length };
  if (!behavior.length || behavioral.notRun || behavioral.timedOut || behavioral.errors) missingEvidence.push('Behavioral execution is absent or incomplete; no pass is inferred.');
  if (ruleChecks.some(c => c.status === 'SKIPPED')) missingEvidence.push('Some repository rules were not executed deterministically.');
  const includedFiles = new Set(options.includedFiles ?? []).size;
  if (!includedFiles) missingEvidence.push('Changed-file scan coverage is unavailable.');
  const confidence = !includedFiles || Object.values(security).every(s => s === 'NOT_RUN') ? 'LOW' : missingEvidence.length ? 'MEDIUM' : 'HIGH';
  return { version: 2, direction: 'HIGHER_IS_RISKIER', enforcement: 'ADVISORY', thresholds: RISK_V2_THRESHOLDS, score, unclampedScore, verdict, blockingCount: new Set([...criticalSecurity, ...secrets].map(findingKey)).size, securityFindingCount: securityFindings.length, corroboratedCount: factors.filter(f => f.corroborated).length, categories: [...new Set(findings.map(f => f.agentType))], byProbe, reasons, factors: factors.slice(0, 200), factorsOmitted: Math.max(0, factors.length - 200), duplicateCount: input.length - findings.length, coverage: { scope: 'CHANGED_FILES_ONLY', includedFiles, ignoredFiles: new Set(options.ignoredFiles ?? []).size, security, rules: { executed: ruleChecks.filter(c => c.status !== 'SKIPPED').length, failed: failedRules.length, skipped: ruleChecks.filter(c => c.status === 'SKIPPED').length }, context, testGaps, behavioral, confidence, missingEvidence } };
}
