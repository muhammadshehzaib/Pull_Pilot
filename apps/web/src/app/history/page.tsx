'use client';

import { useEffect, useState } from 'react';
import { History, GitPullRequest, GitCommit, CheckCircle2, XCircle, Loader2, ChevronRight } from 'lucide-react';
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
      const results = Array.isArray(raw)
        ? (raw as AiSuggestion[])
        : raw && typeof raw === 'object' && Array.isArray(raw.suggestions)
          ? (raw.suggestions as AiSuggestion[])
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="glass-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {job.eventType === 'PULL_REQUEST' ? <GitPullRequest size={18} /> : <GitCommit size={18} />}
            <h3 className="card-title">
              {job.repository.fullName}
              {job.eventType === 'PULL_REQUEST' ? ` · PR #${job.referenceId}` : ` · ${job.referenceId.slice(0, 7)}`}
            </h3>
          </div>
          <span style={{ color: STATUS_COLORS[job.status], fontWeight: 600, fontSize: '0.85rem' }}>
            {STATUS_LABELS[job.status]}
          </span>
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Created {new Date(job.createdAt).toLocaleString()} · {job.findingCount} findings
        </div>
      </div>

      {!job.results || job.results.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          {job.status === 'COMPLETED' ? 'No issues found' : 'No findings recorded.'}
        </div>
      ) : (
        job.results.map((s, i) => (
          <div key={i} className="glass-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <span
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  padding: '1px 7px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: `1px solid ${PRIORITY_COLORS[s.priority]}`,
                  color: PRIORITY_COLORS[s.priority],
                }}
              >
                {PRIORITY_LABELS[s.priority]}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{AGENT_LABELS[s.agentType]}</span>
              <span className="mono" style={{ fontSize: '0.8rem', marginLeft: 'auto' }}>
                {s.filePath}:{s.lineNumber}
              </span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{s.issue}</div>
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
