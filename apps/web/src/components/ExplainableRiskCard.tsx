import { normalizeExplainableRisk } from '../lib/explainableRisk';

export function ExplainableRiskCard({ report }: { report?: unknown }) {
  const risk = normalizeExplainableRisk(report);
  if (!risk) return null;
  const c = risk.coverage;
  return <section className="glass-card" style={{ padding: '1.25rem', marginTop: '1rem' }} aria-label="Explainable PR risk">
    <h3>PR risk v2: {risk.score}/100 · {risk.verdict}</h3>
    <p>0 means lower indicated risk; 100 means higher indicated risk. This is an advisory verdict and does not enforce GitHub merge protection.</p>
    <p>Evidence confidence: <strong>{c.confidence}</strong>. Scope: changed files only ({c.includedFiles} included, {c.ignoredFiles} ignored). Context: {c.context}. Test-gap analysis: {c.testGaps}.</p>
    <p>Thresholds: REVIEW at {risk.thresholds.review}; BLOCK at {risk.thresholds.block}. Security policies and executed failures can also require review or an advisory BLOCK below these thresholds.</p>
    <p>Behavioral scenarios: {c.behavioral.generated} generated, {c.behavioral.executed} executed, {c.behavioral.verified} verified; {c.behavioral.failed} failed, {c.behavioral.notRun} not run, {c.behavioral.timedOut} timed out, {c.behavioral.errors} errors.</p>
    <p>Rules: {c.rules.executed} executed, {c.rules.failed} failed, {c.rules.skipped} skipped. Security probe coverage: {Object.entries(c.security).map(([name, state]) => `${name}: ${state}`).join(' · ')}.</p>
    {c.missingEvidence.length > 0 && <><strong>Missing or partial evidence</strong><ul>{c.missingEvidence.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
    <details><summary>Why this score? ({risk.duplicateCount} duplicate findings removed)</summary>
      <p>Contribution total {risk.unclampedScore}; final score capped at 100. Corroborating detections add no duplicate points.</p>
      <ul>{risk.factors.map((factor, i) => <li key={`${factor.id}-${i}`}>+{factor.points}: {factor.explanation} {factor.filePath && <code>{factor.filePath}:{factor.lineNumber}</code>} · {factor.sources.join(', ')}{factor.corroborated ? ' · corroborated' : ''}</li>)}</ul>
      {risk.factorsOmitted > 0 && <p>{risk.factorsOmitted} additional contributions omitted from this bounded display; included in the score.</p>}
    </details>
  </section>;
}
