'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  AI_DRAFT_DISCLAIMER,
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
 * edit it, then download it for isolated testing without triggering customer CI.
 *
 * Deliberately self-contained: it owns the generate → edit → download
 * state machine and talks to the API directly, so it can be dropped next to any
 * scenario without threading state through the history page.
 */
export function TestDraftFlow({ jobId, scenario }: { jobId: string; scenario: TestGapScenario }) {
  const [draft, setDraft] = useState<TestDraft | null>(null);
  const [targetPath, setTargetPath] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState<'idle' | 'generating' | 'saving'>('idle');
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Drafts are persisted server-side. Restore the latest draft for this exact
  // scenario so a reload does not discard the developer's review/edit state or
  // hide an already-created PR.
  useEffect(() => {
    let active = true;
    setLoadingExisting(true);
    setDraft(null);
    setTargetPath('');
    setContent('');
    setError(null);
    setNotice(null);

    api<{ drafts: TestDraft[] }>(`/api/jobs/${encodeURIComponent(jobId)}/test-drafts`)
      .then(({ drafts }) => {
        if (!active) return;
        const existing = drafts.find((candidate) => {
          if (candidate.status === 'DISCARDED') return false;
          return candidate.sourcePath === scenario.filePath &&
            candidate.scenario?.scenario === scenario.scenario &&
            candidate.scenario?.lineNumber === scenario.lineNumber;
        });
        if (!existing) return;
        setDraft(existing);
        setTargetPath(existing.targetPath);
        setContent(existing.targetContent);
        setNotice(existing.error ?? existing.structuralNote);
      })
      .catch(() => {
        if (active) setNotice('Could not restore a saved draft. You can still generate a new one.');
      })
      .finally(() => {
        if (active) setLoadingExisting(false);
      });

    return () => {
      active = false;
    };
  }, [jobId, scenario.filePath, scenario.scenario, scenario.lineNumber]);

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

  const download = () => {
    const check = validateProposedTestPath(targetPath);
    if (!check.ok || !content.trim()) {
      setError(check.reason ?? 'Draft content is empty.');
      return;
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = targetPath.split('/').pop()!;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const created = draft?.status === 'PR_CREATED';

  return (
    <div style={{ marginTop: '0.6rem' }}>
      {!draft && (
        <button
          type="button"
          className="btn-secondary"
          onClick={generate}
          disabled={loadingExisting || busy === 'generating'}
        >
          {loadingExisting ? 'Loading saved draft…' : busy === 'generating' ? 'Generating draft…' : 'Generate test draft'}
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
              onChange={(e) => { setTargetPath(e.target.value); }}
              disabled={created || busy !== 'idle'}
              className="mono"
              style={{ display: 'block', width: '100%', marginTop: '0.2rem' }}
            />
          </label>

          <label style={{ display: 'block', fontSize: '0.78rem', margin: '0.5rem 0 0.2rem' }}>
            Test contents
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); }}
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
              . Tests were not run by this service.{' '}
              {draft.prUrl ? (
                <a href={`${draft.prUrl}/checks`} target="_blank" rel="noreferrer">
                  Check current CI results
                </a>
              ) : (
                'Check GitHub Actions for current CI results.'
              )}
            </div>
          ) : (
            <>


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
                  onClick={download}
                  disabled={busy !== 'idle' || !validateProposedTestPath(targetPath).ok || !content.trim()}
                >
                  Download draft
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
