'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Report = { version: 1; expected: number; delivered: number; rejected: number; omitted: number;
  pending: number; unconfirmed: number; summary: string };
function parse(value: unknown): Report | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || !['expected', 'delivered', 'rejected', 'omitted', 'pending', 'unconfirmed'].every(k => Number.isSafeInteger(r[k]) && Number(r[k]) >= 0)
    || !['DISABLED', 'WAITING', 'READY', 'SENDING', 'DELIVERED', 'REJECTED', 'UNKNOWN', 'OMITTED'].includes(String(r.summary))) return null;
  return r as Report;
}
const summaryText: Record<string, string> = { DISABLED: 'Disabled', WAITING: 'Waiting for inline delivery', READY: 'Pending',
  SENDING: 'Sending', DELIVERED: 'Delivered', REJECTED: 'Rejected by GitHub', UNKNOWN: 'Delivery unconfirmed', OMITTED: 'Omitted because the PR head changed' };

export function CommentDeliveryCard({ jobId, report }: { jobId: string; report: unknown }) {
  const [value, setValue] = useState(report);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setValue(report); setMessage(''); }, [jobId, report]);
  const data = parse(value);
  async function reconcile() {
    setBusy(true); setMessage('');
    try {
      const result = await api<{ commentDelivery: unknown }>(`/api/jobs/${jobId}/comments/reconcile`, { method: 'POST' });
      setValue(result.commentDelivery);
      setMessage('GitHub checked. No new comments were posted.');
    } catch { setMessage('Delivery could not be checked. No new comments were posted.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Comment delivery" style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' }}>
    <strong>GitHub comment delivery</strong>
    {!data ? <p>Comment delivery was not tracked for this review.</p> : <>
      <p>{data.delivered} of {data.expected} inline comments delivered.</p>
      <p>Summary: {summaryText[data.summary]}.</p>
      {data.rejected > 0 && <p>{data.rejected} inline comment(s) rejected by GitHub. Findings remain available below.</p>}
      {data.omitted > 0 && <p>{data.omitted} inline comment(s) omitted because the PR head changed.</p>}
      {data.pending > 0 && <p>{data.pending} inline comment(s) pending.</p>}
      {(data.unconfirmed > 0 || data.summary === 'UNKNOWN') && <>
        <p>Some comment delivery could not be confirmed. Unconfirmed comments will not be posted again automatically.</p>
      </>}
      {(data.unconfirmed > 0 || data.pending > 0 || ['UNKNOWN', 'SENDING'].includes(data.summary)) &&
        <button type="button" disabled={busy} onClick={reconcile}>{busy ? 'Checking GitHub…' : 'Check existing GitHub comments'}</button>}
      <p>Cancelling stops new requests. A request already sent to GitHub may still finish. Starting a new review can produce new comments.</p>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
