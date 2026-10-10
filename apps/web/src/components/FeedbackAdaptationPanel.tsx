'use client';
import { useEffect, useRef, useState } from 'react';
import { api, type ApiError } from '../lib/api';

interface Insights {
  enabled: boolean; revision: number; partial: boolean; scannedJobs: number;
  policy: { version: string; minReviewedPrs: number; rejectionRatio: number };
  recommendations: Array<{ fingerprint: string; summary?: string; reviewedPrs: number; rejectedPrs: number; reason: string; recommendation: string }>;
}
export function FeedbackAdaptationPanel({ repositoryId }: { repositoryId: string }) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    api<Insights>(`/api/repositories/${repositoryId}/feedback-insights`).then(value => { if (active) setInsights(value); })
      .catch(() => { if (active) setError('Feedback insights unavailable.'); });
    return () => { active = false; };
  }, [repositoryId]);
  async function refresh() {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { setInsights(await api<Insights>(`/api/repositories/${repositoryId}/feedback-insights`)); setError(''); }
    catch { setError('Feedback insights unavailable.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function toggle() {
    if (!insights || lock.current || (!insights.enabled && !consent)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const updated = await api<{ enabled: boolean; revision: number }>(`/api/repositories/${repositoryId}/feedback-adaptation`,
        { method: 'PUT', body: JSON.stringify({ enabled: !insights.enabled, expectedRevision: insights.revision }) });
      setInsights({ ...insights, ...updated }); setConsent(false);
    } catch (err) { setError((err as ApiError).error || 'Settings not confirmed; refresh before retrying.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="glass-card" aria-label="Developer feedback learning">
    <h3>Developer feedback learning</h3>
    <p>Opt-in, reversible presentation adaptation for low-priority model advisories. Security, severity and risk scores remain unchanged. This does not train the model.</p>
    {insights && <>
      <p>Policy {insights.policy.version}: at least {insights.policy.minReviewedPrs} explicitly reviewed PRs, with {insights.policy.rejectionRatio * 100}% sharing a rejection reason. Evaluated {insights.scannedJobs} recent reviews.</p>
      {insights.partial && <p>Evidence limit reached; no adaptation is applied.</p>}
      {!insights.enabled && <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Enable repository-specific presentation adaptation for future reviews</label>}
      <button disabled={busy || (!insights.enabled && !consent)} onClick={toggle}>{insights.enabled ? 'Disable / reset adaptation' : 'Enable feedback adaptation'}</button>
      <p>Reset disables adaptation without deleting feedback. Enabling again recomputes from retained feedback.</p>
      {insights.recommendations.length ? insights.recommendations.map(r => <p key={r.fingerprint}>
        {r.summary || r.fingerprint}: {' '}
        {r.rejectedPrs}/{r.reviewedPrs} reviewed PRs: {r.reason.replace(/_/g, ' ')} — {r.recommendation}
      </p>) : <p>No patterns meet the feedback threshold.</p>}
    </>}
    <button disabled={busy} onClick={() => void refresh()}>Refresh feedback insights</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
