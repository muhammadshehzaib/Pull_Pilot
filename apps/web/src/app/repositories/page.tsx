'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GitBranch, Plus, Trash2, Play, ExternalLink, History, ShieldCheck } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { Pagination } from '../../components/Pagination';
import { useAuth } from '../../lib/useAuth';
import { api, type PaginationMeta } from '../../lib/api';

export const ROUTES = {
  HISTORY: '/history',
  REPOSITORIES: '/repositories',
  DASHBOARD: '/dashboard',
  VAULT: '/vault',
} as const;

interface Repository {
  id: string;
  githubRepoId: string;
  fullName: string;
  webhookId: string | null;
  isActive: boolean;
  createdAt: string;
}

export default function RepositoriesPage() {
  const { user, loading: authLoading } = useAuth();
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [triggerOpen, setTriggerOpen] = useState<string | null>(null);
  const [prNumber, setPrNumber] = useState('');
  const [auditMode, setAuditMode] = useState<'branch' | 'pr'>('branch');
  const [branchName, setBranchName] = useState('main');

  async function refresh(targetPage = page) {
    try {
      const res = await api<{
        repositories: Repository[];
        pagination: PaginationMeta;
        activeCount: number;
      }>(`/api/repositories?page=${targetPage}&limit=50`);
      setRepos(res.repositories);
      setPagination(res.pagination);
      setActiveCount(res.activeCount);
      // Disconnecting the last row of the last page leaves an empty page —
      // step back to the final page that still has content.
      if (res.repositories.length === 0 && res.pagination.page > res.pagination.totalPages) {
        setPage(res.pagination.totalPages);
      }
    } catch {
      // ignore
    } finally {
      setLoadingRepos(false);
    }
  }

  useEffect(() => {
    if (user) refresh(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, page]);

  function goToPage(next: number) {
    setLoadingRepos(true);
    setPage(next);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.includes('/')) {
      setMessage({ kind: 'err', text: 'Use the form "owner/repo".' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<{ warning?: string }>('/api/repositories', {
        method: 'POST',
        body: JSON.stringify({ fullName: fullName.trim() }),
      });
      setFullName('');
      setMessage({
        kind: 'ok',
        text: res.warning
          ? `Repo connected. ${res.warning}`
          : 'Repo connected. Webhook installed on GitHub.',
      });
      // A freshly connected repo sorts to the top of page 1, so make sure the
      // user is looking at the page where it actually appeared.
      if (page === 1) {
        await refresh(1);
      } else {
        setLoadingRepos(true);
        setPage(1);
      }
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to connect.' });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(id: string, name: string) {
    if (!confirm(`Disconnect ${name}? The webhook will be removed from GitHub.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/repositories/${id}`, { method: 'DELETE' });
      setMessage({ kind: 'ok', text: `Disconnected ${name}.` });
      await refresh();
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to disconnect.' });
    } finally {
      setBusy(false);
    }
  }

  async function triggerAudit(repoId: string) {
    setBusy(true);
    setMessage(null);
    try {
      let body: any = {};
      if (auditMode === 'pr') {
        if (!prNumber.trim()) {
          setMessage({ kind: 'err', text: 'Please enter a valid Pull Request number.' });
          setBusy(false);
          return;
        }
        body = { pullNumber: Number(prNumber) };
      } else {
        body = { branch: branchName.trim() || undefined };
      }

      const res = await api<{ jobId: string }>(`/api/repositories/${repoId}/analyze`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const label = auditMode === 'branch' 
        ? `branch '${branchName.trim() || 'default'}'` 
        : `PR #${prNumber}`;
      setMessage({
        kind: 'ok',
        text: `Queued audit for ${label} (Job ${res.jobId.slice(0, 8)}). Check Dashboard or History to see the live results!`,
      });
      setTriggerOpen(null);
      setPrNumber('');
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to queue audit.' });
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || !user) {
    return (
      <div className="dashboard-grid">
        <Sidebar user={null} />
        <main className="main-content" style={{ maxWidth: 900 }}>
          <header style={{ marginBottom: '2.5rem' }}>
            <div className="skeleton" style={{ width: 220, height: 36, marginBottom: '0.75rem', borderRadius: 8 }} />
            <div className="skeleton" style={{ width: 380, height: 16, maxWidth: '90%' }} />
          </header>

          <div className="glass-card" style={{ marginBottom: '2rem', padding: '1.5rem' }}>
            <div className="skeleton" style={{ width: 180, height: 20, marginBottom: '1.25rem' }} />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <div className="skeleton" style={{ flex: 1, height: 42, borderRadius: 8 }} />
              <div className="skeleton" style={{ width: 110, height: 42, borderRadius: 8 }} />
            </div>
          </div>

          <div className="skeleton" style={{ width: 120, height: 16, marginBottom: '1rem' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <RepositorySkeleton />
            <RepositorySkeleton />
            <RepositorySkeleton />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-grid">
      <Sidebar user={user} />
      <main className="main-content" style={{ maxWidth: 900 }}>
        <header style={{ marginBottom: '2.5rem' }}>
          <h1 className="page-title">Repositories</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Connect a repository to review every pull request and push automatically.
          </p>
        </header>

        <form onSubmit={add} className="glass-card" style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Plus size={16} />
            <h3 className="card-title">Connect a repository</h3>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="owner/repo, e.g. vercel/next.js"
              className="text-input"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={busy} className="btn-primary">
              <Plus size={16} /> {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>

        {message && (
          <div className={message.kind === 'ok' ? 'flash flash-ok' : 'flash flash-err'} style={{ marginBottom: '1.5rem' }}>
            {message.text}
          </div>
        )}

        <div className="section-label" style={{ marginBottom: '1rem' }}>
          {loadingRepos ? (
            <div className="skeleton" style={{ width: 120, height: 16 }} />
          ) : (
            `Connected (${activeCount})`
          )}
        </div>

        {loadingRepos ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <RepositorySkeleton />
            <RepositorySkeleton />
          </div>
        ) : repos.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
            <GitBranch size={20} style={{ marginBottom: '0.75rem' }} />
            <p>No repositories connected yet.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {repos.map((r) => (
              <div key={r.id} className="glass-card" style={{ opacity: r.isActive ? 1 : 0.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                    <GitBranch size={18} color="var(--text-secondary)" />
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontWeight: 600, fontSize: '0.9rem' }}>{r.fullName}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {r.isActive
                          ? r.webhookId
                            ? `Active · webhook ${r.webhookId}`
                            : 'Active · manual audits only'
                          : 'Inactive'} · Added {new Date(r.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <a
                      href={`https://github.com/${r.fullName}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary"
                      title="View on GitHub"
                    >
                      <ExternalLink size={14} />
                    </a>
                    {r.isActive && (
                      <>
                        <Link
                          href={`/rules?repo=${r.id}`}
                          className="btn-secondary"
                          title="Engineering Rules"
                        >
                          <ShieldCheck size={14} /> Rules
                        </Link>
                        <Link
                          href={ROUTES.HISTORY}
                          className="btn-secondary"
                          title="View Review Findings"
                        >
                          <History size={14} /> Findings
                        </Link>
                        <button onClick={() => setTriggerOpen(triggerOpen === r.id ? null : r.id)} className="btn-secondary">
                          <Play size={14} /> Audit
                        </button>
                        <button onClick={() => disconnect(r.id, r.fullName)} disabled={busy} className="btn-secondary">
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {triggerOpen === r.id && (
                  <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Select Audit Target
                      </span>
                      <div style={{ display: 'flex', gap: '0.4rem', background: 'rgba(255, 255, 255, 0.05)', padding: '0.2rem', borderRadius: '6px' }}>
                        <button
                          type="button"
                          onClick={() => setAuditMode('branch')}
                          className={auditMode === 'branch' ? 'btn-primary' : 'btn-secondary'}
                          style={{ fontSize: '0.78rem', padding: '0.3rem 0.75rem' }}
                        >
                          Branch (main / master)
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuditMode('pr')}
                          className={auditMode === 'pr' ? 'btn-primary' : 'btn-secondary'}
                          style={{ fontSize: '0.78rem', padding: '0.3rem 0.75rem' }}
                        >
                          Pull Request
                        </button>
                      </div>
                    </div>

                    {auditMode === 'branch' ? (
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          placeholder="Branch name, e.g. main or master"
                          className="text-input"
                          style={{ flex: 1 }}
                        />
                        <button onClick={() => triggerAudit(r.id)} disabled={busy} className="btn-primary" style={{ whiteSpace: 'nowrap' }}>
                          <Play size={14} /> Audit Branch
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <input
                          type="number"
                          value={prNumber}
                          onChange={(e) => setPrNumber(e.target.value)}
                          placeholder="Pull request number, e.g. 1"
                          className="text-input"
                          style={{ flex: 1 }}
                        />
                        <button onClick={() => triggerAudit(r.id)} disabled={busy} className="btn-primary" style={{ whiteSpace: 'nowrap' }}>
                          <Play size={14} /> Queue PR Audit
                        </button>
                      </div>
                    )}

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {auditMode === 'branch'
                        ? 'Audits the latest commit diff on the branch (auto-detects main or master).'
                        : 'Audits all code changes within the specified GitHub Pull Request.'}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <Pagination
          page={page}
          totalPages={pagination?.totalPages ?? 1}
          total={pagination?.total}
          noun="repositories"
          busy={loadingRepos}
          onChange={goToPage}
        />
      </main>
    </div>
  );
}

function RepositorySkeleton() {
  return (
    <div className="glass-card skeleton-card-container" style={{ padding: '1.25rem 1.5rem' }}>
      <div className="skeleton-row-container" style={{ flex: 1 }}>
        <div className="skeleton skeleton-icon-sm" />
        <div className="skeleton-col-group">
          <div className="skeleton skeleton-line-lg" />
          <div className="skeleton skeleton-line-md" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
        <div className="skeleton" style={{ width: 34, height: 32, borderRadius: 8 }} />
        <div className="skeleton" style={{ width: 88, height: 32, borderRadius: 8 }} />
        <div className="skeleton" style={{ width: 72, height: 32, borderRadius: 8 }} />
        <div className="skeleton" style={{ width: 34, height: 32, borderRadius: 8 }} />
      </div>
    </div>
  );
}
