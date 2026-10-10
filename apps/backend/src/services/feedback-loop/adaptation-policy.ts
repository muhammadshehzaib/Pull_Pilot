import type { AiSuggestion } from '../ai/finding-taxonomy';
import { generateFingerprint } from '../historical/fingerprint.service';

export const ADAPTATION_POLICY = { version: 'feedback_v1', minReviewedPrs: 5, minSameReasonPrs: 3, rejectionRatio: 0.8,
  windowDays: 90, maxJobs: 200, maxOccurrences: 10000, maxRecommendations: 100 } as const;
export interface FeedbackEvidence {
  fingerprint: string;
  analysisJob: { referenceId: string };
  feedback: { disposition: string; rejectionReason: string | null; updatedAt: Date } | null;
  expiresAt: Date;
}
const ACTIONS: Record<string, string> = {
  FALSE_POSITIVE: 'Recheck context before presenting this advisory pattern.',
  INTENDED_BEHAVIOR: 'Document intended behavior in an owner-approved repository rule.',
  STYLE_PREFERENCE: 'Propose an explicit repository style guideline.',
  DUPLICATE: 'Consolidate duplicate presentation; do not discard the underlying defect.',
  OUT_OF_SCOPE: 'Ask the owner to define the review scope explicitly.',
};
export interface AdaptationRecommendation {
  fingerprint: string; reviewedPrs: number; rejectedPrs: number; reason: string;
  reasons: Record<string, number>; recommendation: string; expiresAt: string;
}
export function deriveRecommendations(rows: FeedbackEvidence[], now = new Date()): AdaptationRecommendation[] {
  const latest = new Map<string, FeedbackEvidence>();
  for (const row of rows) {
    if (!row.feedback || !(row.expiresAt.getTime() > now.getTime())) continue;
    const key = JSON.stringify([row.fingerprint, row.analysisJob.referenceId]);
    const previous = latest.get(key);
    // Ties fail conservatively: acceptance/reset wins over rejection.
    if (!previous || row.feedback.updatedAt > previous.feedback!.updatedAt ||
      (row.feedback.updatedAt.getTime() === previous.feedback!.updatedAt.getTime() && row.feedback.disposition !== 'REJECTED')) latest.set(key, row);
  }
  const groups = new Map<string, FeedbackEvidence[]>();
  for (const row of latest.values()) {
    if (!['ACCEPTED', 'REJECTED'].includes(row.feedback!.disposition)) continue;
    groups.set(row.fingerprint, [...(groups.get(row.fingerprint) ?? []), row]);
  }
  return [...groups].flatMap(([fingerprint, evidence]) => {
    const reasons: Record<string, number> = {};
    for (const row of evidence) if (row.feedback!.disposition === 'REJECTED' && row.feedback!.rejectionReason) {
      const reason = row.feedback!.rejectionReason;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const [reason, rejectedPrs] = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['', 0];
    if (evidence.length < ADAPTATION_POLICY.minReviewedPrs || rejectedPrs < ADAPTATION_POLICY.minSameReasonPrs ||
      rejectedPrs / evidence.length < ADAPTATION_POLICY.rejectionRatio) return [];
    return [{ fingerprint, reviewedPrs: evidence.length, rejectedPrs, reason, reasons,
      recommendation: ACTIONS[reason] ?? 'Review this signal manually; no automatic adaptation.',
      expiresAt: new Date(Math.min(...evidence.map(row => row.expiresAt.getTime()))).toISOString() }];
  }).sort((a, b) => b.reviewedPrs - a.reviewedPrs || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, ADAPTATION_POLICY.maxRecommendations);
}

/** Never touch evidence-backed findings, security, or correctness failures. */
export function mayDeprioritize(f: AiSuggestion): boolean {
  return ['LOW', 'INFO'].includes(f.priority) && ['STYLE', 'MAINTAINABILITY', 'ARCHITECTURE', 'TESTING'].includes(f.agentType) &&
    (f.source ?? 'LLM') === 'LLM' && !f.corroborated && (f.sources ?? ['LLM']).every(s => s === 'LLM');
}
export function presentationAdaptation(findings: AiSuggestion[], recommendations: AdaptationRecommendation[]) {
  return findings.flatMap(f => {
    const evidence = recommendations.find(r => r.fingerprint === generateFingerprint(f));
    if (!evidence || evidence.reason === 'OTHER' || !mayDeprioritize(f)) return [];
    return [{ finding: f, evidence }];
  });
}
