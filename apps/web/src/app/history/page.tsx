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

  useEffect(() => {
    if (!user) return;
    api<{ jobs: JobSummary[] }>('/api/jobs?limit=50')
      .then((res) => setJobs(res.jobs))
      .catch(() => {})
      .finally(() => setLoadingList(false));
  }, [user]);

  async function openJob(id: string) {
    setLoadingDetail(true);
    try {
      const res = await api<{ job: JobDetail & { results: any } }>(`/api/jobs/${id}`);
      const raw = res.job.results;
      const rawResults = Array.isArray(raw)
        ? (raw as AiSuggestion[])
        : raw && typeof raw === 'object' && Array.isArray(raw.suggestions)
          ? (raw.suggestions as AiSuggestion[])
          : null;

      const priorityOrder: Record<string, number> = { HIGH: 1, MEDIUM: 2, LOW: 3 };
      const results = rawResults
        ? [...rawResults].sort((a, b) => (priorityOrder[a.priority] || 4) - (priorityOrder[b.priority] || 4))
        : null;

      setSelected({ ...res.job, results });
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
          <header style={{ marginBottom: '2.5rem' }}>
            <div className="skeleton" style={{ width: 160, height: 36, marginBottom: '0.75rem', borderRadius: 8 }} />
            <div className="skeleton" style={{ width: 320, height: 16 }} />
          </header>

          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '2rem', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <HistoryRowSkeleton />
              <HistoryRowSkeleton />
              <HistoryRowSkeleton />
            </div>
            <div className="glass-card" style={{ height: 260, padding: '1.5rem' }}>
              <div className="skeleton" style={{ width: '60%', height: 24, marginBottom: '1rem', borderRadius: 6 }} />
              <div className="skeleton" style={{ width: '40%', height: 16, marginBottom: '1.5rem', borderRadius: 6 }} />
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
        <header style={{ marginBottom: '2.5rem' }}>
          <h1 className="page-title">History</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>The last 50 reviews across your connected repositories.</p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '2rem', alignItems: 'start' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="glass-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
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
                className="btn-primary"
                style={{
                  fontSize: '0.82rem',
                  padding: '0.45rem 0.95rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  borderRadius: 8,
                  boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)',
                  cursor: 'pointer',
                }}
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Created {new Date(job.createdAt).toLocaleString()} · {job.findingCount || sortedSuggestions.length} findings
          </div>
          {sortedSuggestions.length > 0 && (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              {(() => {
                const highCount = sortedSuggestions.filter((r) => r.priority === 'HIGH').length;
                const medCount = sortedSuggestions.filter((r) => r.priority === 'MEDIUM').length;
                const lowCount = sortedSuggestions.filter((r) => r.priority === 'LOW').length;
                return (
                  <>
                    {highCount > 0 && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger)' }}>
                        {highCount} High
                      </span>
                    )}
                    {medCount > 0 && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)' }}>
                        {medCount} Medium
                      </span>
                    )}
                    {lowCount > 0 && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: 'rgba(148, 163, 184, 0.15)', color: 'var(--text-secondary)' }}>
                        {lowCount} Low
                      </span>
                    )}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
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
                className="btn-secondary"
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
                title="Copy ready-to-paste prompt for this specific issue"
              >
                {copiedIndex === i ? <Check size={12} color="var(--success)" /> : <Copy size={12} />}
                <span>{copiedIndex === i ? 'Copied Prompt!' : 'Copy for AI'}</span>
              </button>
            </div>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.95rem' }}>{s.issue}</div>
            <pre
              className="mono"
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                padding: '0.75rem',
                borderRadius: 8,
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%' }}>
        <div className="skeleton" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div className="skeleton" style={{ width: '75%', height: 16, borderRadius: 4 }} />
          <div className="skeleton" style={{ width: '50%', height: 12, borderRadius: 4 }} />
        </div>
      </div>
    </div>
  );
}
