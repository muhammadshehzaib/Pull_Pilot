'use client';

import { useRef, useState } from 'react';
import { api, type ApiError } from '../lib/api';
import type { AiSuggestion, AgentType, Priority } from '../lib/review';

type Workflow = NonNullable<AiSuggestion['workflow']>;
interface RuleDraft {
  name: string; description: string; guideline: string; category: AgentType; severity: Priority;
  enforcement: 'LLM'; pattern: null; enabled: boolean;
}
interface Proposal {
  draft: RuleDraft; creationKey: string; repositoryId: string; similarRules: { id: string; name: string }[];
}
export function FindingWorkflowActions({ jobId, finding, onChanged, onReload }: {
  jobId: string; finding: AiSuggestion; onChanged: (workflow: Workflow) => void; onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [savedRule, setSavedRule] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; fromStatus: string; status: string; revision: number }> | null>(null);
  const [copied, setCopied] = useState(false);
  if (!finding.findingId) return null;
  const workflow = finding.workflow ?? { status: 'OPEN', revision: 0 };
  const base = `/api/jobs/${jobId}/findings/${finding.findingId}`;
  async function operation(run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setConflict(false);
    try { await run(); }
    catch (err) {
      const failure = err as ApiError;
      setError(failure.error || 'Operation not confirmed. Your draft is preserved; retry or reload.');
      setConflict(failure.status === 409);
    } finally { lock.current = false; setBusy(false); }
  }
  function transition(status: Workflow['status']) {
    void operation(async () => {
      const res = await api<{ workflow: Workflow }>(`${base}/workflow`, { method: 'PUT',
        body: JSON.stringify({ status, expectedRevision: workflow.revision }) });
      onChanged(res.workflow); setEvents(null);
    });
  }
  const rulesLink = `/rules?repo=${encodeURIComponent(proposal?.repositoryId ?? '')}`;
  return <div style={{ marginTop: '0.75rem' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <button disabled={busy} onClick={() => transition(workflow.status === 'DISMISSED' ? 'OPEN' : 'DISMISSED')}>
        {workflow.status === 'DISMISSED' ? 'Restore finding' : 'Dismiss'}
      </button>
      <button disabled={busy} onClick={() => setFixOpen(!fixOpen)}>Fix</button>
      <button disabled={busy} onClick={() => void operation(async () => {
        const result = await api<Proposal>(`${base}/rule-draft`, { method: 'POST' });
        setProposal(result); setConfirmed(false); setSavedRule(null);
      })}>Create rule</button>
      <button disabled={busy} onClick={() => void operation(async () => {
        if (events) { setEvents(null); return; }
        const result = await api<{ events: NonNullable<typeof events> }>(`${base}/workflow/events`);
        setEvents(result.events);
      })}>Workflow history</button>
      {workflow.status === 'REPORTED_FIXED' && <>
        <span>Developer marked fixed — not independently verified</span>
        <button disabled={busy} onClick={() => transition('OPEN')}>Reopen finding</button>
      </>}
      {workflow.status === 'DISMISSED' && <span>Dismissed, not rejected</span>}
    </div>
    {fixOpen && <section aria-label="Fix guidance">
      <p>Suggested remediation; no code is executed, committed, or verified here.</p>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{finding.suggestion}</pre>
      <button disabled={busy} onClick={() => void operation(async () => {
        await navigator.clipboard.writeText(`Address this finding in ${finding.filePath}:${finding.lineNumber}.\n${finding.issue}\nSuggested remediation (unverified):\n${finding.suggestion}\nInspect the code and add regression tests; do not assume this suggestion is correct.`);
        setCopied(true);
      })}>{copied ? 'Fix instructions copied' : 'Copy fix instructions'}</button>
      <button disabled={busy || workflow.status === 'REPORTED_FIXED'} onClick={() => transition('REPORTED_FIXED')}>Mark fixed</button>
    </section>}
    {proposal && !savedRule && <form aria-label="Proposed repository rule" onSubmit={e => {
      e.preventDefault(); if (!confirmed) return;
      void operation(async () => {
        const result = await api<{ rule: { id: string } }>(`${base}/rule`, { method: 'POST',
          body: JSON.stringify({ ...proposal.draft, creationKey: proposal.creationKey, confirmed: true }) });
        setSavedRule(result.rule.id);
      });
    }}>
      <p>Unvalidated proposal. Model enforcement only; applies repository-wide, not only to this file.</p>
      {proposal.similarRules.length > 0 && <p>Existing similar rules: {proposal.similarRules.map(r => r.name).join(', ')}. <a href={rulesLink}>Open repository rules</a>.</p>}
      <label>Rule name <input required maxLength={120} value={proposal.draft.name} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, name: e.target.value } })} /></label>
      <label>Description <textarea maxLength={500} value={proposal.draft.description} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, description: e.target.value } })} /></label>
      <label>Guideline <textarea required maxLength={2000} value={proposal.draft.guideline} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, guideline: e.target.value } })} /></label>
      <label>Severity <select value={proposal.draft.severity} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, severity: e.target.value as Priority } })}>
        {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map(v => <option key={v}>{v}</option>)}
      </select></label>
      <label>Category <select value={proposal.draft.category} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, category: e.target.value as AgentType } })}>
        {['SECURITY', 'BUG', 'CORRECTNESS', 'PERFORMANCE', 'ARCHITECTURE', 'MAINTAINABILITY', 'STYLE', 'TESTING'].map(v => <option key={v}>{v}</option>)}
      </select></label>
      <label><input type="checkbox" checked={proposal.draft.enabled} onChange={e => setProposal({ ...proposal, draft: { ...proposal.draft, enabled: e.target.checked } })} />Enable for future reviews</label>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed this repository-wide rule and confirm saving it</label>
      <button disabled={busy || !confirmed} type="submit">Save repository rule</button>
      <button disabled={busy} type="button" onClick={() => { setProposal(null); setConfirmed(false); }}>Discard rule draft</button>
      <a href={rulesLink}>Manage existing rules</a>
    </form>}
    {savedRule && <p>Repository rule saved. <a href={rulesLink}>Manage rule</a>. Saving a rule does not mark this finding fixed or verified.</p>}
    {events && <section aria-label="Workflow audit history">{events.length ? events.map(event => <p key={event.id}>rev {event.revision}: {event.fromStatus} → {event.status}</p>) : <p>No workflow changes recorded.</p>}</section>}
    {error && <p role="alert">{error} {conflict && <button onClick={onReload}>Reload review</button>}</p>}
  </div>;
}
