'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  FolderGit2,
  GitPullRequest,
  AlertOctagon,
  CheckCheck,
  SearchCode,
  ShieldAlert,
  Activity,
  Calendar,
  BarChart3,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  Clock,
  TrendingDown,
  TrendingUp,
  Info,
  GitBranch,
} from 'lucide-react';
import { api } from '../lib/api';
import type { EngineeringHealthReport, HealthRepository, HealthReview, Page, RiskPoint } from '../lib/engineering-health';

const display = (value: number | null, risk = false) =>
  value === null ? 'Unavailable' : risk ? `${value.toFixed(1)}/100` : value.toLocaleString();

const date = (value: string) => value.slice(0, 10);

const cards = [
  ['repositories', 'Repositories', '', 'Currently connected active repositories; not restricted by review date.'],
  ['reviewedPRs', 'PRs reviewed', 'all', 'Distinct PRs with a captured completion in this period; latest completed artifact per PR.'],
  ['criticalFindings', 'Critical findings detected', 'critical', 'Critical findings in those artifacts; not a count of currently open issues.'],
  ['developerReportedFixes', 'Developer-reported fixes', 'reportedFixes', 'Findings marked fixed during this period in its selected review artifacts, excluding reopened findings. Self-reported, not verified or issues prevented.'],
  ['suggestedTestGaps', 'Suggested test gaps', 'testGaps', 'Advisory scenarios, not measured missing coverage or executed tests.'],
  ['securityFindings', 'Security findings detected', 'security', 'Unique security findings in selected review artifacts, not a comprehensive security assessment.'],
  ['averageRisk', 'Average indicated PR risk', 'risk', '0 = lower indicated risk, 100 = higher. Missing scores are excluded, never treated as zero.'],
] as const;

function getCardIcon(key: string) {
  switch (key) {
    case 'repositories':
      return <FolderGit2 size={17} strokeWidth={2.2} />;
    case 'reviewedPRs':
      return <GitPullRequest size={17} strokeWidth={2.2} />;
    case 'criticalFindings':
      return <AlertOctagon size={17} strokeWidth={2.2} />;
    case 'developerReportedFixes':
      return <CheckCheck size={17} strokeWidth={2.2} />;
    case 'suggestedTestGaps':
      return <SearchCode size={17} strokeWidth={2.2} />;
    case 'securityFindings':
      return <ShieldAlert size={17} strokeWidth={2.2} />;
    case 'averageRisk':
    default:
      return <Activity size={17} strokeWidth={2.2} />;
  }
}

export function RiskChart({ points }: { points: RiskPoint[] }) {
  // Separate segments across missing buckets: do not turn missing evidence into a zero or join over a gap.
  const segments: string[] = [];
  let segment: string[] = [];
  const x = (index: number) => 35 + (index * 540) / Math.max(points.length - 1, 1);

  points.forEach((p, i) => {
    if (p.averageRisk === null) {
      if (segment.length) segments.push(segment.join(' '));
      segment = [];
    } else {
      segment.push(`${x(i)},${160 - p.averageRisk * 1.3}`);
    }
  });
  if (segment.length) segments.push(segment.join(' '));

  return (
    <section className="eh-section-card" aria-label="Risk trend">
      <div className="eh-section-header">
        <div className="eh-section-title-wrap">
          <div className="eh-section-icon">
            <TrendingUp size={18} />
          </div>
          <div>
            <h2 className="eh-section-title">Indicated risk trend</h2>
            <p className="eh-section-sub">
              Higher scores indicate higher risk. Gaps mean no compatible scored PRs. A PR can appear in multiple buckets; bucket counts are not additive.
            </p>
          </div>
        </div>
      </div>

      <div className="eh-chart-viewport">
        <svg
          viewBox="0 0 600 190"
          role="img"
          aria-label="Average indicated risk from 0 to 100"
          className="eh-chart-svg"
        >
          <defs>
            <linearGradient id="risk-chart-grid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {[0, 50, 100].map((n) => (
            <g key={n}>
              <text x="0" y={164 - n * 1.3} fill="var(--text-muted)" fontSize="11" fontWeight="500">
                {n}
              </text>
              <line
                x1="30"
                x2="580"
                y1={160 - n * 1.3}
                y2={160 - n * 1.3}
                stroke="var(--border)"
                strokeDasharray="4 4"
                strokeWidth="1"
              />
            </g>
          ))}

          {segments.map((s, i) => (
            <polyline
              key={i}
              data-testid="risk-segment"
              points={s}
              fill="none"
              stroke="var(--brand-primary)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {points.map((p, i) =>
            p.averageRisk === null ? null : (
              <circle
                key={p.start}
                cx={x(i)}
                cy={160 - p.averageRisk * 1.3}
                r="4.5"
                fill="#ffffff"
                stroke="var(--brand-primary)"
                strokeWidth="2.5"
                className="eh-chart-dot"
              >
                <title>{`${date(p.start)}: ${display(p.averageRisk, true)} from ${p.scoredPRs} scored PRs`}</title>
              </circle>
            )
          )}

          {points.length > 0 && (
            <>
              <text x="35" y="185" fill="var(--text-secondary)" fontSize="11" fontWeight="500">
                {date(points[0].start)}
              </text>
              <text x="575" y="185" textAnchor="end" fill="var(--text-secondary)" fontSize="11" fontWeight="500">
                {date(points.at(-1)!.start)}
              </text>
            </>
          )}
        </svg>
      </div>

      <details className="eh-details-drawer">
        <summary>View risk data table</summary>
        <div className="eh-table-responsive">
          <table className="eh-table">
            <thead>
              <tr>
                <th>Bucket start (UTC)</th>
                <th>Average risk</th>
                <th>Scored PRs</th>
                <th>Captured PRs</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.start}>
                  <td>
                    <span className="eh-mono-time">{date(p.start)}{p.partialBucket ? ' (partial bucket)' : ''}</span>
                  </td>
                  <td><span className="eh-badge eh-badge-purple">{display(p.averageRisk, true)}</span></td>
                  <td><span className="eh-badge eh-badge-neutral">{p.scoredPRs}</span></td>
                  <td><span className="eh-badge eh-badge-neutral">{p.reviewedPRs}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Paging({ page, onPage }: { page: Page<unknown>['pagination']; onPage: (page: number) => void }) {
  return (
    <div className="eh-pagination">
      <button
        className="eh-page-btn"
        disabled={page.page <= 1}
        onClick={() => onPage(page.page - 1)}
      >
        <ChevronLeft size={14} /> Previous page
      </button>
      <span className="eh-page-info">
        Page {page.page} of {Math.max(1, page.totalPages)} · {page.total} records
      </span>
      <button
        className="eh-page-btn"
        disabled={page.page >= page.totalPages}
        onClick={() => onPage(page.page + 1)}
      >
        Next page <ChevronRight size={14} />
      </button>
    </div>
  );
}

export function EngineeringHealth({ refreshKey = 0 }: { refreshKey?: number }) {
  const [range, setRange] = useState('30d'),
    [bucket, setBucket] = useState('day'),
    [repositoryId, setRepository] = useState('');
  const [refresh, setRefresh] = useState(0),
    [data, setData] = useState<EngineeringHealthReport | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState('all'),
    [reviewPage, setReviewPage] = useState(1),
    [repoPage, setRepoPage] = useState(1);
  const [reviews, setReviews] = useState<Page<HealthReview> | null>(null),
    [repos, setRepos] = useState<Page<HealthRepository> | null>(null);
  const [detailError, setDetailError] = useState('');
  const [repositoryOptions, setRepositoryOptions] = useState<{ id: string; fullName: string }[]>([]);
  const snapshotSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++snapshotSequence.current;
    setLoading(true);
    setError('');
    setData(null);
    setReviews(null);
    setRepos(null);
    setDetailError('');
    const params = new URLSearchParams({ range, bucket });
    if (repositoryId) params.set('repositoryId', repositoryId);

    api<EngineeringHealthReport>(`/api/dashboard/engineering-health?${params}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && sequence === snapshotSequence.current) {
          setData(result);
          setRepositoryOptions((previous) =>
            repositoryId ? [...new Map([...previous, ...result.repositoryOptions].map((r) => [r.id, r])).values()] : result.repositoryOptions
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Engineering health could not be loaded. Please retry.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range, bucket, repositoryId, refresh, refreshKey]);

  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    setReviews(null);
    setRepos(null);
    setDetailError('');
    const params = new URLSearchParams({
      range: data.scope.range,
      bucket: data.scope.bucket,
      asOf: data.scope.end,
      limit: '10',
    });
    if (data.scope.repositoryId) params.set('repositoryId', data.scope.repositoryId);
    params.set('metric', metric);
    params.set('page', String(reviewPage));

    const reviewRequest =
      metric === 'all' && reviewPage === 1
        ? Promise.resolve(data.reviews)
        : api<{ reviews: Page<HealthReview> }>(`/api/dashboard/reviews?${params}`, { signal: controller.signal }).then(
            (r) => r.reviews
          );

    params.set('page', String(repoPage));
    const repoRequest =
      repoPage === 1
        ? Promise.resolve(data.repositories)
        : api<{ repositories: Page<HealthRepository> }>(`/api/dashboard/repositories?${params}`, { signal: controller.signal }).then(
            (r) => r.repositories
          );

    Promise.all([reviewRequest, repoRequest])
      .then(([r, p]) => {
        if (!controller.signal.aborted) {
          setReviews(r);
          setRepos(p);
          // Retention or filter changes can remove the last page of a new snapshot.
          if (reviewPage > r.pagination.totalPages) setReviewPage(Math.max(1, r.pagination.totalPages));
          if (repoPage > p.pagination.totalPages) setRepoPage(Math.max(1, p.pagination.totalPages));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDetailError('Records could not be loaded. Refresh to retry or renew an expired snapshot.');
      });
    return () => controller.abort();
  }, [data, metric, reviewPage, repoPage]);

  function changeScope(update: () => void) {
    setReviewPage(1);
    setRepoPage(1);
    setMetric('all');
    update();
  }

  return (
    <section className="glass-card engineering-health" aria-label="Engineering health">
      {/* Controls Bar */}
      <div className="eh-controls-bar">
        <div className="eh-filter-group">
          <div className="eh-input-pill">
            <Calendar size={14} className="eh-input-icon" />
            <span className="eh-input-label">Period</span>
            <select
              aria-label="Reporting period"
              className="eh-select-native"
              value={range}
              onChange={(e) => changeScope(() => setRange(e.target.value))}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </div>

          <div className="eh-input-pill">
            <BarChart3 size={14} className="eh-input-icon" />
            <span className="eh-input-label">Buckets</span>
            <select
              aria-label="Trend buckets"
              className="eh-select-native"
              value={bucket}
              onChange={(e) => changeScope(() => setBucket(e.target.value))}
            >
              <option value="day">Daily</option>
              <option value="week">Weekly (Monday UTC)</option>
            </select>
          </div>

          <div className="eh-input-pill eh-input-pill-repo">
            <FolderGit2 size={14} className="eh-input-icon" />
            <span className="eh-input-label">Repository</span>
            <select
              aria-label="Repository filter"
              className="eh-select-native"
              value={repositoryId}
              onChange={(e) => changeScope(() => setRepository(e.target.value))}
            >
              <option value="">All connected repositories</option>
              {repositoryOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button className="eh-refresh-btn" onClick={() => setRefresh((n) => n + 1)}>
          <RotateCw size={14} className={loading ? 'eh-spin' : ''} />
          <span>Refresh health</span>
        </button>
      </div>

      {loading && (
        <div className="eh-loading-box" role="status">
          <RotateCw size={18} className="eh-spin" />
          <span>Loading engineering health…</span>
        </div>
      )}

      {error && (
        <div className="eh-alert-banner" role="alert">
          <AlertOctagon size={16} />
          <span>{error}</span>
        </div>
      )}

      {data && (
        <>
          {/* Observation Period Strip */}
          <div className="eh-scope-strip">
            <div className="eh-scope-badge">
              <Clock size={13} />
              <span>
                UTC: {data.scope.start} – {data.scope.end} (end exclusive). Updated {new Date(data.generatedAt).toLocaleString()}.
              </span>
            </div>
          </div>

          {/* Evidence Disclaimers */}
          {data.coverage.partial && (
            <div className="eh-evidence-banner" role="status">
              <Info size={16} className="eh-banner-icon" />
              <div className="eh-banner-text">
                Partial evidence: {data.coverage.capturedPRs} captured PRs, {data.coverage.scoredPRs} scored,{' '}
                {data.coverage.testGapScannedPRs} analyzed for test gaps. {data.coverage.legacyJobsWithoutCompletionDate} legacy reviews have unknown completion dates;{' '}
                {data.coverage.approximatePRs} approximate PRs are excluded. {data.coverage.partialEvidencePRs} captured PRs have incomplete scan or execution evidence.{' '}
                Unavailable is not zero or a passing scan.
              </div>
            </div>
          )}

          {data.coverage.queryLimited && (
            <div className="eh-alert-banner" role="alert">
              <AlertOctagon size={16} />
              <span>Query limit reached. Narrow the reporting period or repository filter; totals are unavailable.</span>
            </div>
          )}

          {data.coverage.repositoryListLimited && (
            <div className="eh-evidence-banner" role="status">
              <Info size={16} className="eh-banner-icon" />
              <div className="eh-banner-text">
                Repository picker and breakdown are limited to the first 500 repositories.
              </div>
            </div>
          )}

          {/* Bento Stats Grid */}
          <div className="eh-cards-grid">
            {cards.map(([key, label, filter, description]) => (
              <div
                key={key}
                className={`glass-card eh-stat-card eh-card-${key} ${
                  filter && metric === filter ? 'eh-card-active' : ''
                }`}
              >
                <div className="eh-card-top-row">
                  <div className={`eh-card-icon-pill eh-icon-${key}`}>
                    {getCardIcon(key)}
                  </div>
                  {filter && metric === filter && (
                    <span className="eh-active-badge">Active</span>
                  )}
                </div>

                {filter ? (
                  <button
                    className="eh-card-title-btn"
                    title={description}
                    onClick={() => {
                      setMetric(filter);
                      setReviewPage(1);
                    }}
                  >
                    <span>{label}</span>
                  </button>
                ) : (
                  <span className="eh-card-title-text" title={description}>
                    {label}
                  </span>
                )}

                <p className="eh-card-value">
                  {display(data.metrics[key], key === 'averageRisk')}
                </p>

                <small className="eh-card-desc">
                  {key === 'averageRisk'
                    ? `${data.coverage.scoredPRs} scored / ${data.coverage.capturedPRs} captured PRs; higher is riskier.`
                    : description}
                </small>
              </div>
            ))}
          </div>

          {/* Comparison Card */}
          <div className="eh-comparison-card">
            <div className="eh-comp-icon">
              {data.comparison.available && data.comparison.percentageChange !== null && data.comparison.percentageChange < 0 ? (
                <TrendingDown size={18} color="var(--success)" />
              ) : data.comparison.available && data.comparison.percentageChange !== null && data.comparison.percentageChange > 0 ? (
                <TrendingUp size={18} color="var(--danger)" />
              ) : (
                <Activity size={18} color="var(--text-secondary)" />
              )}
            </div>
            <p className="eh-comp-text">
              {data.comparison.available && data.comparison.percentageChange !== null
                ? `Average indicated PR risk ${data.comparison.percentageChange < 0 ? 'decreased' : data.comparison.percentageChange > 0 ? 'increased' : 'was unchanged'}${data.comparison.percentageChange === 0 ? '' : ` by ${Math.abs(data.comparison.percentageChange).toFixed(1)}%`} versus the previous equal-length period (${data.comparison.currentScoredPRs} vs ${data.comparison.previousScoredPRs} scored PRs). This is not a measured change in overall code quality.`
                : `Risk comparison unavailable: ${data.comparison.reason}`}
            </p>
          </div>

          {data.coverage.capturedPRs === 0 && !data.coverage.queryLimited && (
            <div className="eh-empty-strip">
              <p>No precisely dated captured PR reviews in this period. Historical reviews remain available in review history.</p>
            </div>
          )}

          {/* Indicated Risk Trend Chart */}
          <RiskChart points={data.trend} />

          {/* Repository Breakdown Section */}
          <section className="eh-section-card">
            <div className="eh-section-header">
              <div className="eh-section-title-wrap">
                <div className="eh-section-icon">
                  <FolderGit2 size={18} />
                </div>
                <h2 className="eh-section-title">Repository breakdown</h2>
              </div>
            </div>

            {repos && (
              <>
                <div className="eh-table-responsive">
                  <table className="eh-table">
                    <thead>
                      <tr>
                        <th>Repository</th>
                        <th>Captured PRs</th>
                        <th>Critical findings</th>
                        <th>Security findings</th>
                        <th>Average risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {repos.items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <button
                              className="eh-repo-btn"
                              onClick={() => changeScope(() => setRepository(r.id))}
                            >
                              <GitBranch size={13} />
                              <span>{r.fullName}</span>
                            </button>
                          </td>
                          <td>
                            <span className="eh-badge eh-badge-neutral">{display(r.reviewedPRs)}</span>
                          </td>
                          <td>
                            <span className={`eh-badge ${r.criticalFindings > 0 ? 'eh-badge-danger' : 'eh-badge-neutral'}`}>
                              {display(r.criticalFindings)}
                            </span>
                          </td>
                          <td>
                            <span className={`eh-badge ${r.securityFindings > 0 ? 'eh-badge-warning' : 'eh-badge-neutral'}`}>
                              {display(r.securityFindings)}
                            </span>
                          </td>
                          <td>
                            <span className="eh-badge eh-badge-purple">
                              {display(r.averageRisk, true)} ({r.scoredPRs} scored)
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Paging page={repos.pagination} onPage={setRepoPage} />
              </>
            )}
          </section>

          {/* Supporting Reviews Section */}
          <section className="eh-section-card">
            <div className="eh-section-header eh-section-header-split">
              <div className="eh-section-title-wrap">
                <div className="eh-section-icon">
                  <GitPullRequest size={18} />
                </div>
                <div>
                  <h2 className="eh-section-title">Supporting reviews · {metric}</h2>
                </div>
              </div>
              <button
                className="eh-reset-pill-btn"
                onClick={() => {
                  setMetric('all');
                  setReviewPage(1);
                }}
              >
                Show all captured PRs
              </button>
            </div>

            {detailError && (
              <div className="eh-alert-banner" role="alert">
                <AlertOctagon size={16} />
                <span>{detailError}</span>
              </div>
            )}

            {!reviews && !detailError && (
              <div className="eh-loading-box" role="status">
                <RotateCw size={16} className="eh-spin" />
                <span>Loading supporting records…</span>
              </div>
            )}

            {reviews && (
              <>
                <div className="eh-table-responsive">
                  <table className="eh-table">
                    <thead>
                      <tr>
                        <th>Review</th>
                        <th>Completed (UTC)</th>
                        <th>Critical</th>
                        <th>Security</th>
                        <th>Suggested gaps</th>
                        <th>Indicated risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reviews.items.map((r) => (
                        <tr key={r.jobId}>
                          <td>
                            <Link href={`/history?job=${encodeURIComponent(r.jobId)}`} className="eh-review-link">
                              <GitPullRequest size={13} />
                              <span>
                                {r.repository} #{r.referenceId}
                              </span>
                            </Link>
                          </td>
                          <td>
                            <span className="eh-mono-time">{r.completedAt}</span>
                          </td>
                          <td>
                            <span className={`eh-badge ${r.criticalCount > 0 ? 'eh-badge-danger' : 'eh-badge-neutral'}`}>
                              {r.criticalCount}
                            </span>
                          </td>
                          <td>
                            <span className={`eh-badge ${r.securityCount > 0 ? 'eh-badge-warning' : 'eh-badge-neutral'}`}>
                              {r.securityCount}
                            </span>
                          </td>
                          <td>
                            <span className="eh-badge eh-badge-neutral">{display(r.testGapCount)}</span>
                          </td>
                          <td>
                            <span className="eh-badge eh-badge-purple">{display(r.riskScore, true)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {reviews.items.length === 0 && (
                  <div className="eh-empty-table-state">
                    <p>No supporting reviews for this metric in this period.</p>
                  </div>
                )}

                <Paging page={reviews.pagination} onPage={setReviewPage} />
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
