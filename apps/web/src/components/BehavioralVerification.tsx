'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { normalizeBehavioral, type BehavioralReport } from '../lib/behavioral';

interface StateResponse { config: unknown; report?: BehavioralReport; runs: { id: string; status: string; reason?: string }[] }
const initialConfig = JSON.stringify({ enabled: true, workflowSha: '', previewHost: '', environment: 'preview', publishers: [] }, null, 2);

export function BehavioralVerification({ jobId, initialReport, onUpdated }: { jobId: string; initialReport?: unknown; onUpdated?: () => void }) {
  const initial = normalizeBehavioral(initialReport);
  const [report, setReport] = useState(initial);
  const [configText, setConfigText] = useState(initialConfig);
  const [configConfirmed, setConfigConfirmed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [scenarioId, setScenarioId] = useState(initial?.scenarios[0]?.id ?? '');
  const [steps, setSteps] = useState('');
  const [deploymentId, setDeploymentId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runStatus, setRunStatus] = useState('');
  const requestKey = useRef<string | null>(null);
  const locked = useRef(false);
  const present = initial !== null;

  useEffect(() => {
    if (!present) return;
    let live = true;
    api<StateResponse>(`/api/behavioral/jobs/${jobId}`).then(data => {
      if (!live) return;
      if (data.config) { setConfigText(JSON.stringify(data.config, null, 2)); setEnabled((data.config as { enabled?: boolean }).enabled === true); }
      setReport(normalizeBehavioral(data.report) ?? initial);
      setRunStatus(data.runs[0]?.status ?? '');
    }).catch(() => { if (live) setError('Behavioral settings are unavailable.'); });
    return () => { live = false; };
    // Initial metadata is a snapshot; explicit Refresh retrieves subsequent CI evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, present]);

  if (!report) return null;
  const invalidate = () => { setConfirmed(false); requestKey.current = null; };
  async function refresh() {
    try {
      const data = await api<StateResponse>(`/api/behavioral/jobs/${jobId}`);
      setReport(normalizeBehavioral(data.report)); setRunStatus(data.runs[0]?.status ?? ''); onUpdated?.();
    } catch { setError('Unable to refresh behavioral evidence.'); }
  }
  async function configure() {
    if (!configConfirmed || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const config = JSON.parse(configText);
      await api(`/api/behavioral/jobs/${jobId}/config`, { method: 'PUT', body: JSON.stringify({ config, confirmed: true }) });
      setEnabled(config.enabled === true); setConfigConfirmed(false); invalidate();
    } catch (err) { setError((err as { error?: string }).error ?? 'Invalid settings or unavailable service.'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function start() {
    if (!confirmed || !enabled || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const parsedSteps = JSON.parse(steps);
      requestKey.current ??= crypto.randomUUID();
      const data = await api<{ run: { status: string; reason?: string } }>(`/api/behavioral/jobs/${jobId}/runs`, { method: 'POST', body: JSON.stringify({ requestKey: requestKey.current, confirmed: true, deploymentId: deploymentId ? Number(deploymentId) : null, scenarios: [{ id: scenarioId, steps: parsedSteps }] }) });
      setRunStatus(data.run.status); setConfirmed(false);
      await refresh();
    } catch (err) { setError((err as { error?: string }).error ?? 'Invalid action JSON or unavailable CI. Retry preserves the request identity.'); }
    finally { locked.current = false; setBusy(false); }
  }
  return (
    <section className="glass-card" style={{ padding: '1.25rem', marginTop: '1rem' }} aria-label="Behavioral verification">
      <h3>Behavioral verification</h3>
      <p>Opt-in execution in repository-owner CI against an approved preview. Generated scenarios remain unverified until executed assertions pass. Results apply only to the recorded commit and scenarios.</p>
      {report.headSha && <p>Reviewed commit: <code>{report.headSha}</code></p>}
      {report.reason && <p role="status">{report.reason}</p>}
      <ul>{report.scenarios.map(s => <li key={s.id}><strong>{s.status}</strong> · {s.stage} · {s.description} <code>{s.filePath}</code>{s.lastAssertionStatus === 'FAILED' && s.status !== 'FAILED' ? ' · Prior executed failure remains evidence until a new assertion run passes.' : ''}</li>)}</ul>
      <details>
        <summary>Owner CI and preview settings</summary>
        <p>Install the documented workflow on your default branch, pin its reviewed commit SHA, and approve one exact preview host, environment and deployment-status publisher. Changes to that branch require reviewing and updating the pin.</p>
        <label>CI configuration JSON<textarea aria-label="CI configuration JSON" rows={9} value={configText} onChange={e => { setConfigText(e.target.value); setConfigConfirmed(false); }} style={{ width: '100%' }} /></label>
        <label><input type="checkbox" checked={configConfirmed} onChange={e => setConfigConfirmed(e.target.checked)} /> I reviewed this CI workflow and approve this preview configuration.</label>
        <button type="button" disabled={busy || !configConfirmed} onClick={configure}>Save CI settings</button>
      </details>
      {report.scenarios.length > 0 && <>
        <label>Scenario<select aria-label="Behavioral scenario" value={scenarioId} onChange={e => { setScenarioId(e.target.value); invalidate(); }}>{report.scenarios.map(s => <option key={s.id} value={s.id}>{s.description}</option>)}</select></label>
        <label>GitHub deployment ID<input aria-label="GitHub deployment ID" inputMode="numeric" value={deploymentId} onChange={e => { setDeploymentId(e.target.value); invalidate(); }} /></label>
        <p>Define explicit actions using existing data-testid values: navigate, click, fill (EMPTY/TEXT/EMAIL fixtures), assertVisible or assertText. Execution permits public HTTPS GET resources only; authentication, form submissions and third-party resources are unavailable.</p>
        <label>Scenario actions JSON<textarea aria-label="Scenario actions JSON" rows={7} value={steps} placeholder={'[{"action":"navigate","path":"/"},{"action":"assertVisible","testId":"your-existing-testid"}]'} onChange={e => { setSteps(e.target.value); invalidate(); }} style={{ width: '100%' }} /></label>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I approve executing these exact actions against this preview in owner CI.</label>
        <button type="button" disabled={!enabled || !confirmed || !steps || busy} onClick={start}>Run in owner CI</button>
      </>}
      {runStatus && <p role="status">Latest run: {runStatus}</p>}
      <button type="button" onClick={refresh} disabled={busy}>Refresh execution results</button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
