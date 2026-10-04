'use client';

import { useEffect, useState } from 'react';
import { History, GitPullRequest, GitCommit, CheckCircle2, XCircle, Loader2, ChevronRight, Copy, Check, Sparkles } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { useAuth } from '../../lib/useAuth';
import { api } from '../../lib/api';
import {
  AGENT_LABELS,
  PRIORITY_ICONS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_COLORS,
  isBlocking,
  isInProgress,
  isTerminalFailure,
  statusLabel,
  tallyBySeverity,
  type AiSuggestion,
  type CommentFailure,
  type EventType,
  type JobStatus,
} from '../../lib/review';

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
}

export default function HistoryPage() {
  const { user, loading: authLoading } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const fetchJobs = async () => {
    try {
      const res = await api<{ jobs: JobSummary[] }>('/api/jobs?limit=50');
      setJobs(res.jobs);
      return res.jobs;
    } catch {
      return [];
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    fetchJobs().then((loadedJobs) => {
      if (loadedJobs && loadedJobs.length > 0 && !selected) {
        openJob(loadedJobs[0].id);
      }
    });
  }, [user]);

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
          <p className="page-header-subtitle">The last 50 reviews across your connected repositories.</p>
        </header>

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
                <p>No reviews yet. Connect a repo and push some code.</p>
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
              <JobDetailView job={selected} />
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

  const sortedSuggestions = (job.results || []).slice().sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  // CRITICAL + HIGH. Surfaced separately because a reviewer deciding whether to
  // approve only needs this number, not the full breakdown.
  const blockingCount = sortedSuggestions.filter((s) => isBlocking(s.priority)).length;

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
        sortedSuggestions.map((s, i) => (
          <div key={i} className="glass-card">
            <div className="finding-card-header">
              <span
                className={`badge-${s.priority.toLowerCase()}`}
                title={isBlocking(s.priority) ? 'Should block a merge' : undefined}
              >
                <span aria-hidden="true">{PRIORITY_ICONS[s.priority]}</span>{' '}
                {PRIORITY_LABELS[s.priority]}
              </span>
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
          </div>
        ))
      )}
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
