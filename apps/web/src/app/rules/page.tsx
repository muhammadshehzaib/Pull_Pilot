'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, Trash2, Save, Pencil, X } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { useAuth } from '../../lib/useAuth';
import { AuthUnavailable } from '../../components/AuthUnavailable';
import { api } from '../../lib/api';
import { AGENT_LABELS, PRIORITY_LABELS, type AgentType, type Priority } from '../../lib/review';
import {
  ENFORCEMENT_HINTS,
  ENFORCEMENT_LABELS,
  type RepositoryRule,
  type RuleEnforcement,
} from '../../lib/rules';

interface RepoOption {
  id: string;
  fullName: string;
}

interface RuleForm {
  name: string;
  description: string;
  guideline: string;
  pattern: string;
  severity: Priority;
  category: AgentType;
  enforcement: RuleEnforcement;
}

const EMPTY_FORM: RuleForm = {
  name: '',
  description: '',
  guideline: '',
  pattern: '',
  severity: 'MEDIUM',
  category: 'MAINTAINABILITY',
  enforcement: 'LLM',
};

const SEVERITIES: Priority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const CATEGORIES: AgentType[] = [
  'SECURITY',
  'BUG',
  'CORRECTNESS',
  'PERFORMANCE',
  'ARCHITECTURE',
  'MAINTAINABILITY',
  'STYLE',
  'TESTING',
];
const ENFORCEMENTS: RuleEnforcement[] = ['LLM', 'DETERMINISTIC', 'BOTH'];

type Message = { kind: 'ok' | 'err'; text: string };

export default function EngineeringRulesPage() {
  const { user, loading: authLoading, error: authError, retry: retryAuth } = useAuth();
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [repoId, setRepoId] = useState('');
  const [rules, setRules] = useState<RepositoryRule[]>([]);
  /** Which repository `rules` belongs to; null until the first fetch settles. */
  const [rulesRepoId, setRulesRepoId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  // Derived instead of a set-in-effect flag: while the rules for the selected
  // repository have not arrived yet, `rulesRepoId` still names the previous
  // one (or nothing), which is exactly the loading condition.
  const loadingRules = reposLoading || (repoId !== '' && rulesRepoId !== repoId);

  // Load the connected repositories once, honouring a ?repo=<id> deep link
  // (the Repositories page links here per row). window.location is read in
  // the effect rather than via useSearchParams to keep this a plain client
  // page with no Suspense requirement.
  useEffect(() => {
    if (!user) return;
    api<{ repositories: Array<{ id: string; fullName: string; isActive: boolean }> }>(
      '/api/repositories?limit=50',
    )
      .then((res) => {
        const active: RepoOption[] = res.repositories
          .filter((r) => r.isActive)
          .map((r) => ({ id: r.id, fullName: r.fullName }));
        setRepos(active);
        const preselect = new URLSearchParams(window.location.search).get('repo');
        setRepoId(preselect && active.some((r) => r.id === preselect) ? preselect : active[0]?.id ?? '');
      })
      .catch(() => setRepos([]))
      .finally(() => setReposLoading(false));
  }, [user]);

  const refreshRules = async (id = repoId) => {
    if (!id) return;
    try {
      const res = await api<{ rules: RepositoryRule[] }>(`/api/repositories/${id}/rules`);
      setRules(res.rules);
      setRulesRepoId(id);
    } catch {
      // Keep the previous list on a transient failure rather than blanking it.
    }
  };

  useEffect(() => {
    if (!repoId) return;
    // State updates live in the promise callbacks — same shape as the vault
    // page — so the effect body itself never writes state synchronously.
    api<{ rules: RepositoryRule[] }>(`/api/repositories/${repoId}/rules`)
      .then((res) => {
        setRules(res.rules);
        setRulesRepoId(repoId);
      })
      .catch(() => {
        // Mark the fetch as settled even on failure so the page shows the
        // last-known list instead of spinning forever.
        setRulesRepoId(repoId);
      });
  }, [repoId]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoId) {
      setMessage({ kind: 'err', text: 'Connect a repository first — rules belong to one repository.' });
      return;
    }
    if (!form.name.trim()) {
      setMessage({ kind: 'err', text: 'Rule name is required.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      guideline: form.guideline.trim() || null,
      pattern: form.pattern.trim() || null,
      severity: form.severity,
      category: form.category,
      enforcement: form.enforcement,
    };
    try {
      if (editingId) {
        await api(`/api/repositories/${repoId}/rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ ...body, expectedRevision: editingRevision }),
        });
        setMessage({ kind: 'ok', text: `Rule "${body.name}" updated.` });
      } else {
        await api(`/api/repositories/${repoId}/rules`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setMessage({ kind: 'ok', text: `Rule "${body.name}" added. It applies from the next review.` });
      }
      resetForm();
      await refreshRules();
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to save the rule.' });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: RepositoryRule) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/repositories/${repoId}/rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !rule.enabled, expectedRevision: rule.revision }),
      });
      setMessage({
        kind: 'ok',
        text: rule.enabled
          ? `"${rule.name}" disabled — it will be ignored by reviews.`
          : `"${rule.name}" enabled.`,
      });
      await refreshRules();
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to update the rule.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: RepositoryRule) {
    if (!confirm(`Delete the rule "${rule.name}"? Past review results keep their recorded check.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/repositories/${repoId}/rules/${rule.id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: rule.revision }) });
      if (editingId === rule.id) resetForm();
      setMessage({ kind: 'ok', text: `Rule "${rule.name}" deleted.` });
      await refreshRules();
    } catch (err) {
      setMessage({ kind: 'err', text: (err as { error?: string }).error || 'Failed to delete the rule.' });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(rule: RepositoryRule) {
    setEditingRevision(rule.revision);
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      description: rule.description ?? '',
      guideline: rule.guideline ?? '',
      pattern: rule.pattern ?? '',
      severity: rule.severity,
      category: rule.category,
      enforcement: rule.enforcement,
    });
    setMessage(null);
  }

  if (authError && !user) return <AuthUnavailable error={authError} retry={retryAuth} />;

  if (authLoading || !user) {
    return (
      <div className="dashboard-grid">
        <Sidebar user={null} />
        <main className="main-content" style={{ maxWidth: 860 }}>
          <header style={{ marginBottom: '2.5rem' }}>
            <div className="skeleton" style={{ width: 240, height: 36, marginBottom: '0.75rem', borderRadius: 8 }} />
            <div className="skeleton" style={{ width: 420, height: 16, maxWidth: '90%' }} />
          </header>
          <div className="glass-card" style={{ height: 220 }} />
        </main>
      </div>
    );
  }

  const needsGuideline = form.enforcement === 'LLM' || form.enforcement === 'BOTH';
  const needsPattern = form.enforcement === 'DETERMINISTIC' || form.enforcement === 'BOTH';

  return (
    <div className="dashboard-grid">
      <Sidebar user={user} />
      <main className="main-content" style={{ maxWidth: 860 }}>
        <header style={{ marginBottom: '2.5rem' }}>
          <h1 className="page-title">Engineering Rules</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Repository-specific rules, stored in your account instead of <code className="mono">.aipr.yml</code>.
            Pattern rules are checked against every added line; model rules are handed to the AI reviewer.
          </p>
        </header>

        <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
          <label className="field">
            <span className="field-label">Repository</span>
            {repos.length === 0 ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                No connected repositories yet — connect one from the Repositories page first.
              </div>
            ) : (
              <select
                className="text-input"
                value={repoId}
                onChange={(e) => {
                  setRepoId(e.target.value);
                  resetForm();
                }}
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

        <form onSubmit={submit} className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ShieldCheck size={16} />
            <h3 className="card-title">{editingId ? 'Edit rule' : 'Add a rule'}</h3>
            {editingId && (
              <button type="button" onClick={resetForm} className="btn-secondary" style={{ marginLeft: 'auto' }}>
                <X size={14} /> Cancel edit
              </button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <label className="field">
              <span className="field-label">Rule name</span>
              <input
                className="text-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. No eval()"
                maxLength={120}
              />
            </label>
            <label className="field">
              <span className="field-label">Enforcement</span>
              <select
                className="text-input"
                value={form.enforcement}
                onChange={(e) => setForm({ ...form, enforcement: e.target.value as RuleEnforcement })}
              >
                {ENFORCEMENTS.map((mode) => (
                  <option key={mode} value={mode}>
                    {ENFORCEMENT_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '-0.6rem' }}>
            {ENFORCEMENT_HINTS[form.enforcement]}
          </div>

          <label className="field">
            <span className="field-label">Description (optional, shown on violations)</span>
            <input
              className="text-input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Why the rule exists / what breaks it"
              maxLength={500}
            />
          </label>

          {needsGuideline && (
            <label className="field">
              <span className="field-label">Rule wording for the model</span>
              <textarea
                className="text-input"
                value={form.guideline}
                onChange={(e) => setForm({ ...form, guideline: e.target.value })}
                placeholder="e.g. Never log credentials, even in debug branches."
                rows={2}
                maxLength={2000}
              />
            </label>
          )}

          {needsPattern && (
            <label className="field">
              <span className="field-label">Pattern (JavaScript regular expression)</span>
              <input
                className="text-input mono"
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
                placeholder={'eval\\(|innerHTML\\s*='}
                maxLength={500}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Matched against every added line in the review diff. Case-sensitive.
              </span>
            </label>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <label className="field">
              <span className="field-label">Severity</span>
              <select
                className="text-input"
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as Priority })}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {PRIORITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Category</span>
              <select
                className="text-input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as AgentType })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {AGENT_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {message && (
            <div className={message.kind === 'ok' ? 'flash flash-ok' : 'flash flash-err'}>{message.text}</div>
          )}

          <div>
            <button type="submit" disabled={busy || !repoId} className="btn-primary">
              <Save size={16} /> {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add rule'}
            </button>
          </div>
        </form>

        <div className="section-label" style={{ marginBottom: '1rem' }}>
          {loadingRules ? 'Loading rules…' : `Rules (${rules.length})`}
        </div>

        {loadingRules ? (
          <div className="glass-card" style={{ height: 90 }} />
        ) : rules.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-secondary)' }}>
            <ShieldCheck size={20} style={{ marginBottom: '0.75rem' }} />
            <p>No rules for this repository yet. Add one above.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {rules.map((rule) => (
              <div key={rule.id} className="glass-card" style={{ opacity: rule.enabled ? 1 : 0.55 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{rule.name}</span>
                      <span className={`badge-${rule.severity.toLowerCase()}`}>
                        {PRIORITY_LABELS[rule.severity]}
                      </span>
                      <span
                        className="badge-info"
                        title={ENFORCEMENT_HINTS[rule.enforcement]}
                        style={{ cursor: 'help' }}
                      >
                        {ENFORCEMENT_LABELS[rule.enforcement]}
                      </span>
                      {!rule.enabled && <span className="badge-info">Disabled</span>}
                    </div>
                    {(rule.description || rule.guideline) && (
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
                        {rule.description || rule.guideline}
                      </div>
                    )}
                    {rule.pattern && (
                      <div className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                        /{rule.pattern}/
                      </div>
                    )}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                      {AGENT_LABELS[rule.category]}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => startEdit(rule)} disabled={busy} className="btn-secondary" title="Edit rule">
                      <Pencil size={14} /> Edit
                    </button>
                    <button onClick={() => toggle(rule)} disabled={busy} className="btn-secondary">
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => remove(rule)} disabled={busy} className="btn-secondary" title="Delete rule">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
