'use client';

import { useEffect, useState } from 'react';
import { History, GitPullRequest, GitCommit, Brain, CheckCircle2, XCircle, Loader2, ChevronRight, Copy, Check, Sparkles } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { Pagination } from '../../components/Pagination';
import { useAuth } from '../../lib/useAuth';
import { api, type PaginationMeta } from '../../lib/api';
import {
  AGENT_LABELS,
  PRIORITY_ICONS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_COLORS,
  isBlocking,
  isInProgress,
  isTerminalFailure,
  sourceColor,
  sourceLabel,
  statusLabel,
  tallyBySeverity,
  type AiSuggestion,
  type CommentFailure,
  type EventType,
  type JobStatus,
} from '../../lib/review';
import {
  CHECK_STATUS_COLORS,
  CHECK_STATUS_LABELS,
  summarizeChecks,
  type RuleCheck,
} from '../../lib/rules';
import {
  PROBE_COLORS,
  PROBE_LABELS,
  SECURITY_CHECK_STATUS_COLORS,
  SECURITY_CHECK_STATUS_LABELS,
  VERDICT_COLORS,
  isBlockingVerdict,
  probeTally,
  riskTone,
  verdictLabel,
  type RiskReport,
  type SecurityCheck,
} from '../../lib/security';
import {
  CONFIDENCE_COLORS,
  confidenceLabel,
  hasTestGaps,
  testGapSummary,
  type TestGapReport,
} from '../../lib/testGap';
import { TestDraftFlow } from '../../components/TestDraftFlow';
import { BehavioralVerification } from '../../components/BehavioralVerification';
import { ExplainableRiskCard } from '../../components/ExplainableRiskCard';
import { FindingFeedbackControl } from '../../components/FindingFeedbackControl';
import { RepositoryInsightsPanel } from '../../components/RepositoryInsightsPanel';
import { FindingWorkflowActions } from '../../components/FindingWorkflowActions';
import { FeedbackAdaptationPanel } from '../../components/FeedbackAdaptationPanel';

export interface JobSummary {
  id: string;
  eventType: EventType;
  referenceId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  findingCount: number;
  repository: { id: string; fullName: string };
}

interface JobDetail extends JobSummary {
  results: AiSuggestion[] | null;
  commentFailures?: CommentFailure[];
  summaryPosted?: boolean;
  /** Per-rule PASS/FAIL/SKIPPED records written by the deterministic engine. */
  ruleChecks?: RuleCheck[];
  /** Per-probe PASS/FAIL/SKIPPED records written by the security layer. */
  securityChecks?: SecurityCheck[];
  /** Risk engine output, rehydrated from the results blob by the controller. */
  metadata?: { risk?: RiskReport; riskV2?: unknown; testGaps?: TestGapReport | null; behavioral?: unknown;
    historicalFeedbackEligible?: boolean;
    historicalMemory?: { version?: number; algorithmVersion?: string; suppliedPatternIds: string[]; patternCount: number; truncated: boolean } };
}

export default function HistoryPage() {
  const { user, loading: authLoading } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // 1-based page into the filtered list. Backend clamps out-of-range values,
  // but every navigation still goes through goToPage so the skeleton shows.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  // Narrowing to a repository or a single PR. The backend filters on these, so
  // "every review this PR has had" no longer depends on the global 50-row list
  // happening to still contain it.
  const [repoFilter, setRepoFilter] = useState('');
  const [scopeToSelected, setScopeToSelected] = useState(false);
  // Accumulated across fetches on purpose. Deriving the dropdown from `jobs`
  // would hide every other repository the moment a filter was applied, leaving
  // no way to switch to a different one.
  const [knownRepos, setKnownRepos] = useState<{ id: string; fullName: string }[]>([]);

  // Dashboard drilldowns open an exact owned review, independent of list pagination.
  useEffect(() => {
    if (!user) return;
    const id = new URLSearchParams(window.location.search).get('job');
    if (id && /^[a-zA-Z0-9-]{1,64}$/.test(id)) void openJob(id);
  }, [user]);

  // When scoping to the selected PR, the referenceId drives the request. PUSH
  // reviews key on a commit SHA, so scoping only makes sense for pull requests.
  const scopedReferenceId =
    scopeToSelected && selected?.eventType === 'PULL_REQUEST' ? selected.referenceId : '';

  /**
   * Does not touch loading state on its own. Loading is owned by whoever caused
   * the fetch (the mount, a filter click, or a page change) so that setting it
   * here would not turn the background poll into a skeleton flash every 3 seconds.
   */
  const fetchJobs = async () => {
    try {
      const params = new URLSearchParams({ limit: '50', page: `${page}` });
      if (repoFilter) params.set('repositoryId', repoFilter);
      if (scopedReferenceId) params.set('referenceId', scopedReferenceId);
      const res = await api<{ jobs: JobSummary[]; pagination: PaginationMeta }>(
        `/api/jobs?${params.toString()}`,
      );
      setJobs(res.jobs);
      setPagination(res.pagination);
      // Filters can shrink the list underneath the current page (cleared PR,
      // retention sweep). Land on the last page that still exists rather than
      // leaving the user staring at an empty list with nowhere to go.
      if (res.jobs.length === 0 && res.pagination.page > res.pagination.totalPages) {
        setPage(res.pagination.totalPages);
      }
      setKnownRepos((prev) => {
        const merged = new Map(prev.map((r) => [r.id, r.fullName]));
        for (const job of res.jobs) merged.set(job.repository.id, job.repository.fullName);
        return Array.from(merged, ([id, fullName]) => ({ id, fullName })).sort((a, b) =>
          a.fullName.localeCompare(b.fullName),
        );
      });
      return res.jobs;
    } catch {
      return [];
    } finally {
      setLoadingList(false);
    }
  };

  /**
   * Every filter change goes through here so the skeleton and the query agree.
   * The page also resets to 1: a filter that leaves 2 matching rows must not
   * keep the user on page 4 of the unfiltered list.
   */
  function applyFilter(update: () => void) {
    setLoadingList(true);
    setPage(1);
    update();
  }

  /** Page navigation: same skeleton ownership, but the filters stay put. */
  function goToPage(next: number) {
    setLoadingList(true);
    setPage(next);
  }

  // Fetch on mount and whenever the page or a filter changes. `loadingList`
  // already starts true, so mounting needs no explicit setState here.
  useEffect(() => {
    if (!user) return;
    fetchJobs();
  }, [user, page, repoFilter, scopedReferenceId]);

  // Auto-poll while any review is in flight. This used to test for RUNNING and
  // QUEUED only, so the moment the backend reported ANALYZING the page stopped
  // refreshing and the user watched a stale review until they reloaded.
  useEffect(() => {
    const hasActiveJob = jobs.some((j) => isInProgress(j.status));
    if (!hasActiveJob) return;

    const interval = setInterval(async () => {
      const updatedJobs = await fetchJobs();
      if (selected) {
        const stillSelected = updatedJobs.find((j) => j.id === selected.id);
        if (stillSelected && stillSelected.status !== selected.status) {
          openJob(selected.id);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [jobs, selected]);

  async function openJob(id: string) {
    setLoadingDetail(true);
    try {
      const res = await api<{ job: JobDetail }>(`/api/jobs/${id}`);
      setSelected(res.job);
      const findingsCount = Array.isArray(res.job.results) ? res.job.results.length : 0;
      setJobs((prev) =>
        prev.map((j) =>
          j.id === res.job.id
            ? {
                ...j,
                status: res.job.status,
                findingCount: findingsCount,
              }
            : j
        )
      );
    } catch {
      // ignore
    } finally {
      setLoadingDetail(false);
    }
  }

  if (authLoading || !user) {
    return (
      <div className="dashboard-grid">
        <Sidebar user={null} />
        <main className="main-content">
          <header className="page-header-container">
            <div className="skeleton skeleton-title" style={{ marginBottom: '0.75rem' }} />
            <div className="skeleton skeleton-subtitle" />
          </header>

          <div className="history-layout-grid">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <HistoryRowSkeleton />
              <HistoryRowSkeleton />
              <HistoryRowSkeleton />
            </div>
            <div className="glass-card" style={{ height: 260, padding: '1.5rem' }}>
              <div className="skeleton skeleton-line-lg" style={{ marginBottom: '1rem' }} />
              <div className="skeleton skeleton-line-md" style={{ marginBottom: '1.5rem' }} />
              <div className="skeleton" style={{ width: '100%', height: 100, borderRadius: 8 }} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-grid">
      <Sidebar user={user} />
      <main className="main-content">
        <header className="page-header-container">
          <h1 className="page-title">History</h1>
          <p className="page-header-subtitle">
            Every review across your connected repositories, filterable by repo or pull request.
          </p>
        </header>

        <div
          className="history-filter-bar"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}
        >
          <label className="section-label" htmlFor="repo-filter" style={{ marginBottom: 0 }}>
            Repository
          </label>
          <select
            id="repo-filter"
            className="history-filter-select"
            value={repoFilter}
            onChange={(e) => applyFilter(() => setRepoFilter(e.target.value))}
            style={{
              background: 'var(--bg-card, rgba(255,255,255,0.05))',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color, rgba(148,163,184,0.25))',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: '0.8rem',
              minWidth: '14rem',
            }}
          >
            <option value="">All repositories</option>
            {knownRepos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>

          {selected?.eventType === 'PULL_REQUEST' && (
            <button
              type="button"
              className={scopeToSelected ? 'btn-primary' : 'btn-secondary'}
              onClick={() => applyFilter(() => setScopeToSelected((prev) => !prev))}
              aria-pressed={scopeToSelected}
              title="Show only previous reviews of this pull request"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <GitPullRequest size={13} />
              {scopeToSelected ? `PR #${selected.referenceId} only` : 'Scope to this PR'}
            </button>
          )}

          {(repoFilter || scopeToSelected) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                applyFilter(() => {
                  setRepoFilter('');
                  setScopeToSelected(false);
                })
              }
            >
              Clear
            </button>
          )}

          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {pagination?.total ?? jobs.length} review{(pagination?.total ?? jobs.length) === 1 ? '' : 's'}
            {scopedReferenceId ? ` on PR #${scopedReferenceId}` : ''}
          </span>
        </div>

        <div className="history-layout-grid">
          <div>
            {loadingList ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <HistoryRowSkeleton />
                <HistoryRowSkeleton />
                <HistoryRowSkeleton />
                <HistoryRowSkeleton />
              </div>
            ) : jobs.length === 0 ? (
              <div className="glass-card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                <History size={20} strokeWidth={2} style={{ marginBottom: '1rem' }} />
                <p>
                  {repoFilter || scopeToSelected
                    ? 'No reviews match this filter.'
                    : 'No reviews yet. Connect a repo and push some code.'}
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {jobs.map((job) => (
                  <button
                    key={job.id}
                    onClick={() => openJob(job.id)}
                    className="history-row"
                    data-active={selected?.id === job.id ? 'true' : 'false'}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <StatusIcon status={job.status} />
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '2px' }}>
                          {job.eventType === 'PULL_REQUEST' ? <GitPullRequest size={14} /> : <GitCommit size={14} />}
                          <span className="mono" style={{ fontSize: '0.85rem' }}>
                            {job.repository.fullName}
                            {job.eventType === 'PULL_REQUEST' ? ` #${job.referenceId}` : ` @ ${job.referenceId.slice(0, 7)}`}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {new Date(job.createdAt).toLocaleString()} · {job.findingCount} findings
                        </div>
                      </div>
                      <ChevronRight size={14} style={{ color: 'var(--text-secondary)' }} />
                    </div>
                  </button>
                ))}
              </div>
            )}

            <Pagination
              page={page}
              totalPages={pagination?.totalPages ?? 1}
              total={pagination?.total}
              noun="reviews"
              busy={loadingList}
              onChange={goToPage}
            />
          </div>

          <div>
            {!selected ? (
              <div className="glass-card" style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                <History size={20} strokeWidth={2} style={{ marginBottom: '1rem' }} />
                <p>Select a review to see findings.</p>
              </div>
            ) : loadingDetail ? (
              <div className="glass-card" style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</div>
            ) : (
              <JobDetailView key={selected.id} job={selected} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatusIcon({ status }: { status: JobStatus }) {
  const color = STATUS_COLORS[status] ?? 'var(--text-secondary)';
  if (status === 'COMPLETED') return <CheckCircle2 size={18} color={color} />;
  if (isTerminalFailure(status)) return <XCircle size={18} color={color} />;
  // Every in-flight phase spins, not just RUNNING, so a review that is waiting
  // on the model still reads as active.
  if (isInProgress(status) && status !== 'QUEUED') {
    return <Loader2 size={18} color={color} className="spin" />;
  }
  return <div style={{ width: 8, height: 8, borderRadius: 4, background: color, marginLeft: 5, marginRight: 5 }} />;
}

function JobDetailView({ job }: { job: JobDetail }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [liveRisk, setLiveRisk] = useState(job.metadata?.riskV2);
  const [showInsights, setShowInsights] = useState(false);
  const [feedbackFindings, setFeedbackFindings] = useState(job.results ?? []);
  const [backfilling, setBackfilling] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [showDeprioritized, setShowDeprioritized] = useState(false);
  useEffect(() => { setFeedbackFindings(job.results ?? []); setFeedbackError(''); }, [job.id, job.results]);
  useEffect(() => { setLiveRisk(job.metadata?.riskV2); }, [job.id, job.metadata?.riskV2]);

  const sortedSuggestions = feedbackFindings.slice().sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  // CRITICAL + HIGH. Surfaced separately because a reviewer deciding whether to
  // approve only needs this number, not the full breakdown.
  const blockingCount = sortedSuggestions.filter((s) => isBlocking(s.priority)).length;
  const visibleSuggestions = sortedSuggestions.filter(s =>
    (showDismissed || s.workflow?.status !== 'DISMISSED') && (showDeprioritized || !s.adaptation));
  async function reloadFeedback() {
    try {
      const result = await api<{ job: JobDetail }>(`/api/jobs/${job.id}`);
      setFeedbackFindings(result.job.results ?? []); setFeedbackError('');
    } catch { setFeedbackError('Could not reload this review. Your draft has not been discarded.'); }
  }

  async function backfillFeedback() {
    if (backfilling) return;
    setBackfilling(true);
    setFeedbackError('');
    try {
      await api(`/api/jobs/${job.id}/findings/backfill`, { method: 'POST' });
      const result = await api<{ job: JobDetail }>(`/api/jobs/${job.id}`);
      setFeedbackFindings(result.job.results ?? []);
    } catch {
      setFeedbackError('Could not enable feedback. The review may have changed or expired; reload and retry.');
    } finally { setBackfilling(false); }
  }

  async function handleCopyAll() {
    const plan = generateFixPlanForLLM(job, sortedSuggestions);
    await navigator.clipboard.writeText(plan);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2500);
  }

  async function handleCopySingle(item: AiSuggestion, idx: number) {
    const prompt = generateSingleFindingPrompt(item, job.repository.fullName);
    await navigator.clipboard.writeText(prompt);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2500);
  }

  return (
    <div className="detail-view-card">
      <div className="glass-card">
        <div className="detail-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {job.eventType === 'PULL_REQUEST' ? <GitPullRequest size={18} /> : <GitCommit size={18} />}
            <h3 className="card-title">
              {job.repository.fullName}
              {job.eventType === 'PULL_REQUEST' ? ` · PR #${job.referenceId}` : ` · ${job.referenceId.slice(0, 7)}`}
            </h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button type="button" className="btn-secondary" onClick={() => setShowInsights(true)}>
              <Brain size={15} /> Historical insights
            </button>
            {sortedSuggestions.length > 0 && (
              <button
                type="button"
                onClick={handleCopyAll}
                className="btn-primary copy-fix-plan-btn"
                title="Copy entire fix plan formatted for an LLM (Claude, ChatGPT, Cursor, Gemini, etc.)"
              >
                {copiedAll ? <Check size={15} /> : <Sparkles size={15} />}
                <span>{copiedAll ? 'Fix Plan Copied to Clipboard!' : 'Copy Fix Plan for AI'}</span>
              </button>
            )}
            <span style={{ color: STATUS_COLORS[job.status] ?? 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>
              {statusLabel(job.status)}
            </span>
          </div>
        </div>
        <div className="detail-meta-row">
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Created {new Date(job.createdAt).toLocaleString()} · {job.findingCount || sortedSuggestions.length} findings
          </div>
          {sortedSuggestions.length > 0 && (
            <div className="detail-badge-group">
              {tallyBySeverity(sortedSuggestions).map(({ level, label, icon, count }) => (
                <span key={level} className={`badge-${level.toLowerCase()}`} title={`${count} ${label}`}>
                  <span aria-hidden="true">{icon}</span> {count} {label}
                </span>
              ))}
              {blockingCount > 0 && (
                <span className="badge-critical" title="Severities that should block a merge">
                  🚧 {blockingCount} blocking
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {job.commentFailures && job.commentFailures.length > 0 && (
        <div
          className="glass-card"
          style={{
            borderLeft: '3px solid var(--warning)',
            padding: '0.75rem 1rem',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--warning)' }}>
            ⚠️ {job.commentFailures.length} finding(s) could not be posted as inline
            comments
          </strong>
          <div style={{ marginTop: '0.4rem' }}>
            GitHub rejected the cited location — usually the line is not part of this
            diff. These findings are included in the PR summary and listed below.
          </div>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
            {job.commentFailures.map((f, i) => (
              <li key={i}>
                <code>{f.location}</code> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {job.ruleChecks && job.ruleChecks.length > 0 && (
        <div className="glass-card" style={{ padding: '0.9rem 1rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
              flexWrap: 'wrap',
              marginBottom: '0.6rem',
            }}
          >
            <strong style={{ fontSize: '0.88rem' }}>📏 Repository rules</strong>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              {summarizeChecks(job.ruleChecks)}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {job.ruleChecks.map((check) => (
              <div
                key={check.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  fontSize: '0.82rem',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    color: CHECK_STATUS_COLORS[check.status],
                    fontWeight: 600,
                    minWidth: 104,
                  }}
                >
                  {check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : '•'}{' '}
                  {CHECK_STATUS_LABELS[check.status]}
                </span>
                <span style={{ fontWeight: 500 }}>{check.ruleName}</span>
                {check.status === 'FAIL' && (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {check.violationCount} violating {check.violationCount === 1 ? 'line' : 'lines'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(job.metadata?.risk || (job.securityChecks && job.securityChecks.length > 0)) && (
        <SecurityCard risk={job.metadata?.risk} checks={job.securityChecks} legacy={Boolean(job.metadata?.riskV2)} />
      )}

      {job.metadata?.testGaps && hasTestGaps(job.metadata.testGaps) && (
        <TestGapCard report={job.metadata.testGaps} jobId={job.id} />
      )}
      <ExplainableRiskCard report={liveRisk} />
      {Boolean(job.metadata?.historicalMemory?.patternCount) && (
        <div
          className="historical-memory-attribution-card"
          style={{
            padding: '0.75rem 1rem',
            borderRadius: '10px',
            backgroundColor: 'var(--accent-soft, #eff6ff)',
            border: '1px solid var(--border-accent, rgba(37,99,235,0.25))',
            fontSize: '0.8rem',
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Brain size={16} color="var(--accent, #2563eb)" />
          <span>
            <strong>Historical Review Memory Active:</strong> {job.metadata?.historicalMemory?.patternCount} recurring pattern(s) were supplied as untrusted background context. Findings still require evidence in the current changes; this is not independent verification.
            {job.metadata?.historicalMemory?.truncated && ' Some patterns were omitted to fit the context limit.'}
            {job.metadata?.historicalMemory?.algorithmVersion && ` Algorithm: ${job.metadata.historicalMemory.algorithmVersion}.`}
          </span>
        </div>
      )}
      {showInsights && (
        <RepositoryInsightsPanel
          repositoryId={job.repository.id}
          repositoryName={job.repository.fullName}
          onClose={() => setShowInsights(false)}
        />
      )}
      <BehavioralVerification jobId={job.id} initialReport={job.metadata?.behavioral} onUpdated={() => {
        api<{ job: JobDetail }>(`/api/jobs/${job.id}`).then(data => setLiveRisk(data.job.metadata?.riskV2)).catch(() => {});
      }} />

      {job.status === 'COMPLETED' && sortedSuggestions.some(finding => !finding.findingId) && (
        <div className="glass-card">
          {job.metadata?.historicalFeedbackEligible ? (
            <button type="button" onClick={backfillFeedback} disabled={backfilling}>
              {backfilling ? 'Enabling feedback…' : 'Enable feedback for this review'}
            </button>
          ) : <span>Historical feedback is unavailable for this review (90-day retention).</span>}
          {feedbackError && <p role="alert">{feedbackError}</p>}
        </div>
      )}

      {sortedSuggestions.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          {job.status === 'COMPLETED' ? (
            <>
              <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--success)', marginBottom: '0.4rem' }}>
                ✅ No issues found
              </div>
              Nothing in this diff met the reporting bar. That is a real result, not
              a failed review.
            </>
          ) : isTerminalFailure(job.status) ? (
            <>
              <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--danger)', marginBottom: '0.4rem' }}>
                ⚠️ Review {statusLabel(job.status).toLowerCase()}
              </div>
              This review ended without findings. Check the repository configuration
              and webhook delivery, then re-run it.
            </>
          ) : (
            <>
              <div style={{ marginBottom: '0.4rem' }}>{statusLabel(job.status)}…</div>
              Findings appear here as soon as the review reaches this stage.
            </>
          )}
        </div>
      ) : (
        <>
        <div className="glass-card">
          <label><input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)} />Show dismissed findings ({sortedSuggestions.filter(s => s.workflow?.status === 'DISMISSED').length})</label>
          <details onToggle={e => setShowDeprioritized(e.currentTarget.open)}>
            <summary>Show deprioritized advisories ({sortedSuggestions.filter(s => s.adaptation).length})</summary>
            <p>These findings remain available below. Feedback changes presentation only, not severity, evidence or risk scores.</p>
          </details>
          {visibleSuggestions.length === 0 && <p>No findings in the active worklist. Expand advisories or show dismissed findings to inspect all results.</p>}
        </div>
        {visibleSuggestions.map((s, i) => (
          <div key={s.findingId ?? `${s.filePath}:${s.lineNumber}:${i}`} className="glass-card">
            <div className="finding-card-header">
              <span
                className={`badge-${s.priority.toLowerCase()}`}
                title={isBlocking(s.priority) ? 'Should block a merge' : undefined}
              >
                <span aria-hidden="true">{PRIORITY_ICONS[s.priority]}</span>{' '}
                {PRIORITY_LABELS[s.priority]}
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid',
                  borderColor: sourceColor(s.source),
                  color: sourceColor(s.source),
                  fontWeight: 500,
                }}
                title={
                  s.source === 'RULES'
                    ? 'Found by a deterministic repository rule — no model judgement involved'
                    : s.source
                      ? `Found by the ${sourceLabel(s.source)} security probe`
                      : 'Found by the AI reviewer'
                }
              >
                {sourceLabel(s.source)}
              </span>
              {s.corroborated && (
                <span
                  style={{ fontSize: '0.72rem', color: '#d97706', fontWeight: 500 }}
                  title="A deterministic security probe flagged this same line — most reviewers treat it as higher confidence"
                >
                  ✓ corroborated
                </span>
              )}
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {AGENT_LABELS[s.agentType] ?? s.agentType}
              </span>
              <span className="mono" style={{ fontSize: '0.8rem', marginLeft: 'auto', marginRight: '0.5rem', color: 'var(--text-secondary)' }}>
                {s.filePath}:{s.lineNumber}
              </span>
              <button
                type="button"
                onClick={() => handleCopySingle(s, i)}
                className="btn-secondary copy-single-issue-btn"
                title="Copy ready-to-paste prompt for this specific issue"
              >
                {copiedIndex === i ? <Check size={12} color="var(--success)" /> : <Copy size={12} />}
                <span>{copiedIndex === i ? 'Copied Prompt!' : 'Copy for AI'}</span>
              </button>
            </div>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.95rem' }}>{s.issue}</div>
            <pre className="mono finding-code-container">
              {s.suggestion}
            </pre>
            {s.adaptation && <p>Deprioritized by {s.adaptation.policyVersion}: {s.adaptation.rejectedPrs}/{s.adaptation.reviewedPrs} reviewed PRs marked a similar pattern {s.adaptation.reason.replace(/_/g, ' ').toLowerCase()}. Not evidence that this finding is incorrect.</p>}
            {job.status === 'COMPLETED' && <FindingFeedbackControl
              jobId={job.id} findingId={s.findingId} initialFeedback={s.feedback}
              onFeedbackChanged={feedback => setFeedbackFindings(current => current.map(finding =>
                finding.findingId === s.findingId ? { ...finding, feedback } : finding))}
            />}
            {job.status === 'COMPLETED' && <FindingWorkflowActions jobId={job.id} finding={s}
              onReload={() => void reloadFeedback()}
              onChanged={workflow => setFeedbackFindings(current => current.map(finding =>
                finding.findingId === s.findingId ? { ...finding, workflow } : finding))} />}
          </div>
        ))}
        </>
      )}
      <FeedbackAdaptationPanel key={job.repository.id} repositoryId={job.repository.id} />
    </div>
  );
}

function generateFixPlanForLLM(job: JobDetail, suggestions: AiSuggestion[]): string {
  const repoName = job.repository.fullName;
  const refLabel = job.eventType === 'PULL_REQUEST' ? `PR #${job.referenceId}` : `Commit ${job.referenceId}`;
  const breakdown = tallyBySeverity(suggestions)
    .map(({ level, count }) => `${count} ${PRIORITY_LABELS[level]}`)
    .join(', ');

  let markdown = `# 🛠️ Comprehensive Code Fix Plan: ${repoName}\n`;
  markdown += `**Target:** ${refLabel} | **Total Findings:** ${suggestions.length}${
    breakdown ? ` (${breakdown})` : ''
  }\n\n`;
  markdown += `You are an expert Principal Software Engineer and Architect. An automated code review identified ${suggestions.length} issue(s) in this repository. Follow the strategic plan below to solve each issue with production-ready, strictly typed code.\n\n`;

  markdown += `## 🧭 Execution Strategy\n`;
  markdown += `1. **Phase 1 (Critical):** Resolve all Critical-severity exploitable vulnerabilities, data-loss risks, and outright crashes first.\n`;
  markdown += `2. **Phase 2 (High):** Fix High-severity correctness and security bugs that affect real users or documented contracts.\n`;
  markdown += `3. **Phase 3 (Robustness):** Address Medium-severity bugs, performance bottlenecks, and concurrency issues.\n`;
  markdown += `4. **Phase 4 (Refinement):** Fix Low and Info-severity maintainability issues, test gaps, and naming consistency.\n`;
  markdown += `5. **Zero \`any\` Policy:** Avoid \`as any\` casts; implement discriminated unions and proper runtime type guards.\n`;
  markdown += `6. **Backwards Compatibility:** Maintain existing public interfaces, APIs, and ensure no regressions.\n\n`;

  markdown += `## 📋 Actionable Findings (Most Severe First)\n\n`;

  suggestions.forEach((item, index) => {
    markdown += `### ${index + 1}. ${PRIORITY_ICONS[item.priority]} [${item.priority}] ${AGENT_LABELS[item.agentType] ?? item.agentType} Flaw\n`;
    markdown += `- **Location:** \`${item.filePath}:${item.lineNumber}\`\n`;
    markdown += `- **Category:** ${AGENT_LABELS[item.agentType] ?? item.agentType}\n`;
    markdown += `- **Priority:** ${item.priority}\n\n`;
    markdown += `**Problem Statement:**\n${item.issue}\n\n`;
    markdown += `**Prescribed Fix / Implementation Guidance:**\n\`\`\`\n${item.suggestion}\n\`\`\`\n\n`;
    markdown += `---\n\n`;
  });

  markdown += `## 🎯 Deliverables Requested from You\n`;
  markdown += `For each impacted file:\n`;
  markdown += `1. Provide the exact file path and a concise explanation of the root cause.\n`;
  markdown += `2. Provide the complete, clean replacement code or precise git diff.\n`;
  markdown += `3. Verify that all exported functions, types, and dependencies match the project standards.\n`;

  return markdown;
}

function generateSingleFindingPrompt(item: AiSuggestion, repoName: string): string {
  return `### Task: Fix ${PRIORITY_ICONS[item.priority]} [${item.priority}] ${AGENT_LABELS[item.agentType] ?? item.agentType} in \`${item.filePath}:${item.lineNumber}\`

**Context:**
- **Repository:** \`${repoName}\`
- **File:** \`${item.filePath}\` (around line ${item.lineNumber})
- **Category:** ${AGENT_LABELS[item.agentType] ?? item.agentType}
- **Severity:** ${item.priority}

---

### Issue Description:
${item.issue}

### Prescribed Fix:
\`\`\`
${item.suggestion}
\`\`\`

---

### Instructions for LLM:
You are an expert senior software engineer. Please review the file \`${item.filePath}\` and implement a clean, robust, production-ready solution for the issue described above.
- Eliminate unsafe type assertions (\`as any\`) and ensure strict TypeScript typing.
- Preserve all existing functionality, error handling, and public contracts.
- Return the full updated file or the exact replacement code block so it can be directly applied.`;
}

function HistoryRowSkeleton() {
  return (
    <div className="history-row" style={{ pointerEvents: 'none' }}>
      <div className="skeleton-row-container">
        <div className="skeleton skeleton-icon-sm" />
        <div className="skeleton-col-group">
          <div className="skeleton skeleton-line-lg" />
          <div className="skeleton skeleton-line-md" />
        </div>
      </div>
    </div>
  );
}

/**
 * Deterministic security layer summary: risk score + verdict from the risk
 * engine, per-probe finding tallies, and the durable PASS/FAIL rows the worker
 * wrote for SAST / secrets / dependencies.
 */
function SecurityCard({ risk, checks, legacy }: { risk?: RiskReport; checks?: SecurityCheck[]; legacy?: boolean }) {
  const score = typeof risk?.score === 'number' && Number.isFinite(risk.score) ? risk.score : 0;
  const tone = riskTone(score);
  const toneColor = tone === 'block' ? 'var(--danger)' : tone === 'review' ? 'var(--warning)' : 'var(--success)';
  const blocking = risk ? isBlockingVerdict(risk.verdict) : false;

  return (
    <div
      className="glass-card"
      style={{
        padding: '0.9rem 1rem',
        borderLeft: blocking ? '3px solid var(--danger)' : '3px solid transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.6rem',
        }}
      >
        <strong style={{ fontSize: '0.88rem' }}>🛡️ Security risk{legacy ? ' (legacy v1)' : ''}</strong>
        {risk && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ color: toneColor, fontWeight: 700, fontSize: '1.05rem' }}>{score}/100</span>
            <span
              style={{
                color: VERDICT_COLORS[risk.verdict] ?? 'var(--text-secondary)',
                fontWeight: 600,
                fontSize: '0.82rem',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {verdictLabel(risk.verdict)}
            </span>
          </span>
        )}
      </div>

      {risk && risk.reasons && risk.reasons.length > 0 && (
        <ul style={{ margin: '0 0 0.6rem', paddingLeft: '1.1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {risk.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}

      {risk && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.6rem', fontSize: '0.8rem' }}>
          {probeTally(risk).map(({ probe, count }) => (
            <span key={probe} style={{ color: PROBE_COLORS[probe], fontWeight: 500 }}>
              {PROBE_LABELS[probe]}: {count}
            </span>
          ))}
        </div>
      )}

      {checks && checks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {checks.map((check) => (
            <div
              key={check.id}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', fontSize: '0.82rem' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <span style={{ color: SECURITY_CHECK_STATUS_COLORS[check.status], fontWeight: 600, minWidth: 96 }}>
                  {check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : check.status === 'DEGRADED' ? '⚠' : '•'}{' '}
                  {SECURITY_CHECK_STATUS_LABELS[check.status]}
                </span>
                <span style={{ fontWeight: 500 }}>{check.ruleName}</span>
                {check.findingCount > 0 && (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {check.findingCount} finding{check.findingCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {check.detail && (
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', paddingLeft: '0.2rem' }}>
                  {check.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Advisory list of tests the worker believes the change is missing. Nothing
 * here is executed and nothing affects the verdict, so the card is styled with
 * a neutral accent rather than the danger language used for findings.
 */
function TestGapCard({ report, jobId }: { report: TestGapReport; jobId: string }) {
  const scenarios = report.scenarios ?? [];

  return (
    <div className="glass-card" style={{ padding: '0.9rem 1rem', borderLeft: '3px solid var(--accent)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.6rem',
        }}
      >
        <strong style={{ fontSize: '0.88rem' }}>🧪 Test gaps</strong>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {testGapSummary(report)}
        </span>
      </div>

      {scenarios.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {scenarios.map((scenario, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.82rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <span
                  style={{
                    color: CONFIDENCE_COLORS[scenario.confidence] ?? 'var(--text-secondary)',
                    fontWeight: 600,
                    minWidth: 56,
                  }}
                >
                  {confidenceLabel(scenario.confidence)}
                </span>
                <span style={{ fontWeight: 500 }}>{scenario.scenario}</span>
              </div>
              <span style={{ color: 'var(--text-secondary)', paddingLeft: '0.2rem' }}>
                <code>{scenario.filePath}</code>
                {scenario.lineNumber > 1 ? `:${scenario.lineNumber}` : ''} — expects: {scenario.expected}
              </span>
              {scenario.edgeCase && (
                <span style={{ color: 'var(--text-secondary)', paddingLeft: '0.2rem', fontSize: '0.78rem' }}>
                  Edge case: {scenario.edgeCase}
                </span>
              )}
              <TestDraftFlow key={`${scenario.filePath}:${scenario.lineNumber}:${i}`} jobId={jobId} scenario={scenario} />
            </div>
          ))}
        </div>
      )}

      {report.evidence?.incomplete && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          ⚠ Discovery only saw part of the repository, so the list may be incomplete.
        </div>
      )}
    </div>
  );
}
