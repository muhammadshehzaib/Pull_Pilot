'use client';

import { useEffect, useState } from 'react';
import { History, GitPullRequest, GitCommit, CheckCircle2, XCircle, Loader2, ChevronRight, Copy, Check, Sparkles } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { useAuth } from '../../lib/useAuth';
import { api } from '../../lib/api';

type EventType = 'PULL_REQUEST' | 'PUSH';
type JobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

interface JobSummary {
  id: string;
  eventType: EventType;
  referenceId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  findingCount: number;
  repository: { id: string; fullName: string };
}

interface AiSuggestion {
  filePath: string;
  lineNumber: number;
  agentType: 'SECURITY' | 'PERFORMANCE' | 'ARCHITECTURE';
  issue: string;
  suggestion: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

interface JobDetail extends JobSummary {
  results: AiSuggestion[] | null;
}

const STATUS_COLORS: Record<JobStatus, string> = {
  QUEUED: 'var(--text-secondary)',
  RUNNING: 'var(--accent)',
  COMPLETED: 'var(--success)',
  FAILED: 'var(--danger)',
};

const PRIORITY_COLORS = {
  HIGH: 'var(--danger)',
  MEDIUM: 'var(--warning)',
  LOW: 'var(--text-secondary)',
};

const STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

const PRIORITY_LABELS = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' } as const;

const AGENT_LABELS = {
  SECURITY: 'Security',
  PERFORMANCE: 'Performance',
  ARCHITECTURE: 'Architecture',
} as const;

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

  // If any job is currently RUNNING or QUEUED, auto-poll every 3 seconds to keep UI synced
  useEffect(() => {
    const hasActiveJob = jobs.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
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
  const color = STATUS_COLORS[status];
  if (status === 'COMPLETED') return <CheckCircle2 size={18} color={color} />;
  if (status === 'FAILED') return <XCircle size={18} color={color} />;
  if (status === 'RUNNING') return <Loader2 size={18} color={color} className="spin" />;
  return <div style={{ width: 8, height: 8, borderRadius: 4, background: color, marginLeft: 5, marginRight: 5 }} />;
}

function JobDetailView({ job }: { job: JobDetail }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const sortedSuggestions = (job.results || []).slice().sort((a, b) => {
    const pOrder: Record<string, number> = { HIGH: 1, MEDIUM: 2, LOW: 3 };
    return (pOrder[a.priority] || 4) - (pOrder[b.priority] || 4);
  });

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
            <span style={{ color: STATUS_COLORS[job.status], fontWeight: 600, fontSize: '0.85rem' }}>
              {STATUS_LABELS[job.status]}
            </span>
          </div>
        </div>
        <div className="detail-meta-row">
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Created {new Date(job.createdAt).toLocaleString()} · {job.findingCount || sortedSuggestions.length} findings
          </div>
          {sortedSuggestions.length > 0 && (
            <div className="detail-badge-group">
              {(() => {
                const highCount = sortedSuggestions.filter((r) => r.priority === 'HIGH').length;
                const medCount = sortedSuggestions.filter((r) => r.priority === 'MEDIUM').length;
                const lowCount = sortedSuggestions.filter((r) => r.priority === 'LOW').length;
                return (
                  <>
                    {highCount > 0 && <span className="badge-high">{highCount} High</span>}
                    {medCount > 0 && <span className="badge-medium">{medCount} Medium</span>}
                    {lowCount > 0 && <span className="badge-low">{lowCount} Low</span>}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {sortedSuggestions.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          {job.status === 'COMPLETED' ? 'No issues found' : 'No findings recorded.'}
        </div>
      ) : (
        sortedSuggestions.map((s, i) => (
          <div key={i} className="glass-card">
            <div className="finding-card-header">
              <span
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: `1px solid ${PRIORITY_COLORS[s.priority]}`,
                  color: PRIORITY_COLORS[s.priority],
                }}
              >
                {PRIORITY_LABELS[s.priority]}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {AGENT_LABELS[s.agentType]}
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
  const high = suggestions.filter((s) => s.priority === 'HIGH');
  const medium = suggestions.filter((s) => s.priority === 'MEDIUM');
  const low = suggestions.filter((s) => s.priority === 'LOW');

  let markdown = `# 🛠️ Comprehensive Code Fix Plan: ${repoName}\n`;
  markdown += `**Target:** ${refLabel} | **Total Findings:** ${suggestions.length} (${high.length} High, ${medium.length} Medium, ${low.length} Low)\n\n`;
  markdown += `You are an expert Principal Software Engineer and Architect. An automated code review identified ${suggestions.length} issue(s) in this repository. Follow the strategic plan below to solve each issue with production-ready, strictly typed code.\n\n`;

  markdown += `## 🧭 Execution Strategy\n`;
  markdown += `1. **Phase 1 (Critical):** Resolve all High-severity architectural, security, and runtime failure risks first.\n`;
  markdown += `2. **Phase 2 (Robustness):** Address Medium-severity bugs, performance bottlenecks, and concurrency issues.\n`;
  markdown += `3. **Phase 3 (Refinement):** Fix Low-severity code smells, strict type definitions, and naming consistency.\n`;
  markdown += `4. **Zero \`any\` Policy:** Avoid \`as any\` casts; implement discriminated unions and proper runtime type guards.\n`;
  markdown += `5. **Backwards Compatibility:** Maintain existing public interfaces, APIs, and ensure no regressions.\n\n`;

  markdown += `## 📋 Actionable Findings (Ordered High to Low Severity)\n\n`;

  suggestions.forEach((item, index) => {
    const icon = item.priority === 'HIGH' ? '🚨' : item.priority === 'MEDIUM' ? '⚠️' : 'ℹ️';
    markdown += `### ${index + 1}. ${icon} [${item.priority}] ${item.agentType} Flaw\n`;
    markdown += `- **Location:** \`${item.filePath}:${item.lineNumber}\`\n`;
    markdown += `- **Category:** ${item.agentType}\n`;
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
  const icon = item.priority === 'HIGH' ? '🚨' : item.priority === 'MEDIUM' ? '⚠️' : 'ℹ️';
  return `### Task: Fix ${icon} [${item.priority}] ${item.agentType} in \`${item.filePath}:${item.lineNumber}\`

**Context:**
- **Repository:** \`${repoName}\`
- **File:** \`${item.filePath}\` (around line ${item.lineNumber})
- **Category:** ${item.agentType}
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
