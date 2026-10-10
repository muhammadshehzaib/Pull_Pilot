'use client';

import { useState, useEffect } from 'react';
import {
  Brain,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileCode,
  ShieldAlert,
  Loader2,
  X,
  Layers,
  HelpCircle,
} from 'lucide-react';
import { api, type ApiError } from '../lib/api';

export interface PatternInsight {
  id: string;
  fingerprint: string;
  algorithmVersion: string;
  category: string;
  source: string;
  summary: string;
  occurrenceCount: number;
  distinctPrCount: number;
  acceptedCount: number;
  rejectedCount: number;
  unreviewedCount: number;
  rejectionReasons: Record<string, number>;
  representativePaths: string[];
  isRecurring: boolean;
  firstObservedAt: string;
  lastObservedAt: string;
  aggregatedAt: string;
}

export interface InsightsData {
  repositoryId: string;
  historicalIntelligenceEnabled: boolean;
  freshness: string;
  insufficientHistory: boolean;
  recurringPrThreshold: number;
  summary: {
    totalOccurrences: number;
    distinctPatternsCount: number;
    recurringPatternsCount: number;
    acceptedTotal: number;
    rejectedTotal: number;
    falsePositiveTotal: number;
    unreviewedTotal: number;
  };
  patterns: PatternInsight[];
}

export interface RepositoryInsightsPanelProps {
  repositoryId: string;
  repositoryName?: string;
  onClose?: () => void;
}

export function RepositoryInsightsPanel({
  repositoryId,
  repositoryName,
  onClose,
}: RepositoryInsightsPanelProps) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchInsights();
  }, [repositoryId]);

  async function fetchInsights(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await api<InsightsData>(
        `/api/repositories/${repositoryId}/historical-insights${refresh ? '?refresh=true' : ''}`,
      );
      setData(res);
    } catch (err: unknown) {
      setError((err as ApiError).error || 'Failed to load historical insights.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function handleToggleEnabled() {
    if (!data || toggling) return;
    setToggling(true);
    const newEnabled = !data.historicalIntelligenceEnabled;
    try {
      await api(`/api/repositories/${repositoryId}/historical-intelligence/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: newEnabled }),
      });
      setData((prev) => (prev ? { ...prev, historicalIntelligenceEnabled: newEnabled } : null));
    } catch (err: unknown) {
      alert((err as ApiError).error || 'Failed to update repository settings.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div
      className="repository-insights-modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        className="glass-card repository-insights-panel"
        data-testid="repository-insights-panel"
        style={{
          width: '100%',
          maxWidth: '850px',
          maxHeight: '90vh',
          backgroundColor: 'var(--surface, #ffffff)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-bento)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-subtle, #f8fafc)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: '10px',
                background: 'var(--brand-gradient)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
              }}
            >
              <Brain size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Historical Intelligence & Insights
              </h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {repositoryName ? `${repositoryName} · ` : ''}
                {data?.freshness ? `Aggregated ${new Date(data.freshness).toLocaleTimeString()}` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              type="button"
              disabled={refreshing || loading}
              onClick={() => fetchInsights(true)}
              className="btn-secondary"
              title="Re-aggregate patterns from completed reviews"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '0.8rem',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
              <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
            {onClose && (
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                <X size={20} />
              </button>
            )}
          </div>
        </div>

        {/* Content body */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-muted)' }}>
              <Loader2 size={32} className="spin" style={{ margin: '0 auto 0.75rem' }} />
              <div>Analyzing repository history and compiling patterns…</div>
            </div>
          ) : error ? (
            <div
              style={{
                padding: '1rem',
                borderRadius: '8px',
                backgroundColor: 'var(--danger-soft)',
                color: 'var(--danger)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          ) : data ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Settings banner */}
              <div
                style={{
                  padding: '1rem',
                  borderRadius: '12px',
                  backgroundColor: data.historicalIntelligenceEnabled
                    ? 'var(--accent-soft, #eff6ff)'
                    : 'var(--bg-subtle, #f8fafc)',
                  border: '1px solid var(--border-accent, rgba(37,99,235,0.25))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                    Review Memory Injection (Opt-In)
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    When enabled, recurring cross-PR patterns guide future reviews as background context.
                  </div>
                </div>
                <button
                  type="button"
                  id="toggle-historical-intelligence-btn"
                  disabled={toggling}
                  onClick={handleToggleEnabled}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '999px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: toggling ? 'default' : 'pointer',
                    border: 'none',
                    backgroundColor: data.historicalIntelligenceEnabled
                      ? 'var(--success, #10b981)'
                      : 'var(--text-muted, #94a3b8)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  {data.historicalIntelligenceEnabled ? '✓ Enabled' : 'Disabled'}
                </button>
              </div>

              {/* Summary cards */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: '0.75rem',
                }}
              >
                <div
                  style={{
                    padding: '0.85rem',
                    borderRadius: '10px',
                    backgroundColor: 'var(--bg-subtle, #f8fafc)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Total Occurrences
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                    {data.summary.totalOccurrences}
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.85rem',
                    borderRadius: '10px',
                    backgroundColor: 'var(--bg-subtle, #f8fafc)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Recurring Patterns
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--brand-primary, #1211ff)', marginTop: '2px' }}>
                    {data.summary.recurringPatternsCount}
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.85rem',
                    borderRadius: '10px',
                    backgroundColor: 'var(--bg-subtle, #f8fafc)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    Accepted Findings
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--success, #10b981)', marginTop: '2px' }}>
                    {data.summary.acceptedTotal}
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.85rem',
                    borderRadius: '10px',
                    backgroundColor: 'var(--bg-subtle, #f8fafc)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                    False Positives
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--danger, #ef4444)', marginTop: '2px' }}>
                    {data.summary.falsePositiveTotal}
                  </div>
                </div>
              </div>

              {/* Insufficient History Warning if applicable */}
              {data.insufficientHistory && (
                <div
                  style={{
                    padding: '1rem',
                    borderRadius: '10px',
                    backgroundColor: 'var(--warning-soft, #fffbeb)',
                    border: '1px solid rgba(245, 158, 11, 0.25)',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    fontSize: '0.82rem',
                  }}
                >
                  <HelpCircle size={20} color="var(--warning, #f59e0b)" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--warning, #f59e0b)' }}>
                      Collecting Historical Patterns
                    </div>
                    <div>
                      Durable review memory requires patterns supported by at least{' '}
                      <strong>{data.recurringPrThreshold} distinct pull requests</strong>. Continue reviewing PRs
                      and providing feedback to populate recurring insights.
                    </div>
                  </div>
                </div>
              )}

              {/* Patterns list */}
              <div>
                <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.75rem', color: 'var(--text-primary)' }}>
                  Observed Cross-PR Patterns ({data.patterns.length})
                </h4>

                {data.patterns.length === 0 ? (
                  <div
                    style={{
                      textAlign: 'center',
                      padding: '2rem',
                      color: 'var(--text-muted)',
                      backgroundColor: 'var(--bg-subtle)',
                      borderRadius: '10px',
                      fontSize: '0.85rem',
                    }}
                  >
                    No patterns observed in this 90-day review window yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {data.patterns.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          padding: '1rem',
                          borderRadius: '10px',
                          border: '1px solid var(--border)',
                          backgroundColor: 'var(--surface)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.5rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span
                              style={{
                                fontSize: '0.72rem',
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: '6px',
                                backgroundColor: 'var(--bg-subtle)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border)',
                              }}
                            >
                              {p.category}
                            </span>
                            <span
                              style={{
                                fontSize: '0.72rem',
                                padding: '2px 8px',
                                borderRadius: '999px',
                                backgroundColor: p.isRecurring ? 'var(--accent-soft, #eff6ff)' : 'var(--bg-subtle)',
                                color: p.isRecurring ? 'var(--accent, #2563eb)' : 'var(--text-secondary)',
                                fontWeight: 600,
                              }}
                            >
                              🔁 {p.distinctPrCount} distinct PR(s) · {p.occurrenceCount} total
                            </span>
                          </div>

                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            Last seen: {new Date(p.lastObservedAt).toLocaleDateString()}
                          </div>
                        </div>

                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                          {p.summary}
                        </div>

                        {p.representativePaths.length > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            <FileCode size={13} />
                            <span>Affected paths:</span>
                            {p.representativePaths.map((path) => (
                              <code
                                key={path}
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: 'var(--bg-subtle)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                {path}
                              </code>
                            ))}
                          </div>
                        )}

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            fontSize: '0.75rem',
                            marginTop: '0.25rem',
                            paddingTop: '0.5rem',
                            borderTop: '1px solid var(--border-subtle, rgba(0,0,0,0.05))',
                          }}
                        >
                          <span style={{ color: 'var(--success, #10b981)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <CheckCircle2 size={12} /> {p.acceptedCount} accepted
                          </span>
                          <span style={{ color: 'var(--danger, #ef4444)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <XCircle size={12} /> {p.rejectedCount} rejected
                          </span>
                          {p.rejectionReasons && Object.keys(p.rejectionReasons).length > 0 && (
                            <span style={{ color: 'var(--text-secondary)' }}>
                              ({Object.entries(p.rejectionReasons)
                                .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                                .join(', ')})
                            </span>
                          )}
                          <span style={{ color: 'var(--text-muted)' }}>
                            {p.unreviewedCount} unreviewed
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Safety notice */}
              <div
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--text-muted)',
                  backgroundColor: 'var(--bg-subtle)',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <ShieldAlert size={14} style={{ flexShrink: 0 }} />
                <span>
                  Safety Policy: Historical context is background guidance only. All review findings require concrete
                  evidence in changed code. Security checks and risk scores are never weakened by feedback.
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
