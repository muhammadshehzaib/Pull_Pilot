'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import {
  AI_DRAFT_DISCLAIMER,
  canCreateTestPr,
  validateProposedTestPath,
  type TestDraft,
} from '../lib/testDraft';
import type { TestGapScenario } from '../lib/testGap';

interface GenerateResponse {
  draft: TestDraft | null;
  insufficient?: boolean;
  reason?: string;
}

const errorMessage = (err: unknown, fallback: string): string => {
  const message = (err as { error?: string })?.error;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
};

/**
 * The Phase 5 flow for a single test-gap scenario: generate a draft, review and
 * edit it, then — only after explicit confirmation — open a test PR.
 *
 * Deliberately self-contained: it owns the generate → edit → confirm → create
 * state machine and talks to the API directly, so it can be dropped next to any
 * scenario without threading state through the history page.
 */
export function TestDraftFlow({ jobId, scenario }: { jobId: string; scenario: TestGapScenario }) {
  const [draft, setDraft] = useState<TestDraft | null>(null);
  const [targetPath, setTargetPath] = useState('');
  const [content, setContent] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'generating' | 'saving' | 'creating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const generate = async () => {
    setBusy('generating');
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ draft: TestDraft | null; insufficient?: boolean; reason?: string }>(
        '/api/test-drafts',
        { method: 'POST', body: JSON.stringify({ jobId, scenario }) },
      );
      if (res.insufficient || !res.draft) {
        setNotice(res.reason ?? 'The repository context was not enough to draft a test.');
        return;
      }
      setDraft(res.draft);
      setTargetPath(res.draft.targetPath);
      setContent(res.draft.targetContent);
      setConfirmed(false);
      setNotice(res.draft.structuralNote);
    } catch (err) {
      setError((err as { error?: string }).error ?? 'Could not generate a draft.');
    } finally {
      setBusy('idle');
    }
  };

  const save = async () => {
    if (!draft) return;
    const check = validateProposedTestPath(targetPath);
    if (!check.ok) {
      setError(check.reason ?? 'Unsafe path.');
      return;
    }
    setBusy('saving');
    setError(null);
    try {
      const res = await api<{ draft: TestDraft }>(`/api/test-drafts/${draft.id}`, {
        method: 'PUT',
        body: JSON.stringify({ targetPath, targetContent: content }),
      });
      setDraft(res.draft);
      setTargetPath(res.draft.targetPath);
      setContent(res.draft.targetContent);
      setNotice(res.draft.structuralNote);
    } catch (err) {
      setError((err as { error?: string }).error ?? 'Could not save the draft.');
    } finally {
      setBusy('idle');
    }
  };

  const discard = async () => {
    if (!draft) return;
    setBusy('saving');
    setError(null);
    try {
      await api(`/api/test-drafts/${draft.id}`, { method: 'DELETE' });
      setDraft(null);
      setNotice(null);
    } catch (err) {
      setError((err as { error?: string }).error ?? 'Could not discard the draft.');
    } finally {
      setBusy('idle');
    }
  };

  const createPr = async () => {
    if (!draft || !canCreateTestPr(draft, confirmed)) return;
    setBusy('creating');
    setError(null);
    try {
      const res = await api<{ draft: TestDraft }>(`/api/test-drafts/${draft.id}/create-pr`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
      setDraft(res.draft);
    } catch (err) {
      setError((err as { error?: string }).error ?? 'Could not create the test PR.');
    } finally {
      setBusy('idle');
    }
  };

  const created = draft?.status === 'PR_CREATED';

  return (
    <div style={{ marginTop: '0.6rem' }}>
      {!draft && (
        <button
          type="button"
          className="btn-secondary"
          onClick={generate}
          disabled={busy === 'generating'}
        >
          {busy === 'generating' ? 'Generating draft…' : 'Generate test draft'}
        </button>
      )}

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {error}
        </div>
      )}
      {notice && !draft && (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {notice}
        </div>
      )}

      {draft && (
        <div
          className="glass-card"
          style={{ padding: '0.9rem 1rem', marginTop: '0.6rem', borderLeft: '3px solid var(--accent)' }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
            Review AI-drafted test{' '}
            <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
              {draft.framework ? `· ${draft.framework}` : ''}
            </span>
          </div>
          <p style={{ color: 'var(--warning)', fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
            {AI_DRAFT_DISCLAIMER}
          </p>

          <label style={{ display: 'block', fontSize: '0.78rem', marginBottom: '0.2rem' }}>
            Test file path
            <input
              type="text"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              disabled={created || busy !== 'idle'}
              className="mono"
              style={{ display: 'block', width: '100%', marginTop: '0.2rem' }}
            />
          </label>

          <label style={{ display: 'block', fontSize: '0.78rem', margin: '0.5rem 0 0.2rem' }}>
            Test contents
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              disabled={created || busy !== 'idle'}
              className="mono"
              style={{ display: 'block', width: '100%', marginTop: '0.2rem' }}
            />
          </label>

          {notice && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '0.4rem' }}>
              {notice}
            </div>
          )}
          {draft.notes && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '0.4rem' }}>
              {draft.notes}
            </div>
          )}

          {created ? (
            <div style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
              PR created:{' '}
              {draft.prUrl ? (
                <a href={draft.prUrl} target="_blank" rel="noreferrer">
                  #{draft.prNumber}
                </a>
              ) : (
                `#${draft.prNumber}`
              )}
              . CI has not run.
            </div>
          ) : (
            <>
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.8rem', marginTop: '0.7rem' }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  I understand this creates a new branch and pull request containing AI-generated,
                  unverified tests, and that CI has not run.
                </span>
              </label>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn-secondary" onClick={save} disabled={busy !== 'idle'}>
                  {busy === 'saving' ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" className="btn-secondary" onClick={discard} disabled={busy !== 'idle'}>
                  Discard
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={createPr}
                  disabled={!canCreateTestPr(draft, confirmed) || busy !== 'idle'}
                >
                  {busy === 'creating' ? 'Creating PR…' : 'Create test PR'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
