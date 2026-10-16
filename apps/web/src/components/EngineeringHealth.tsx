'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import type { EngineeringHealthReport, HealthRepository, HealthReview, Page, RiskPoint } from '../lib/engineering-health';

const display = (value: number | null, risk = false) => value === null ? 'Unavailable' : risk ? `${value.toFixed(1)}/100` : value.toLocaleString();
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

export function RiskChart({ points }: { points: RiskPoint[] }) {
  // Separate segments across missing buckets: do not turn missing evidence into a zero or join over a gap.
  const segments: string[] = []; let segment: string[] = [];
  const x = (index: number) => 35 + index * 540 / Math.max(points.length - 1, 1);
  points.forEach((p, i) => {
    if (p.averageRisk === null) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
    else segment.push(`${x(i)},${160 - p.averageRisk * 1.3}`);
  });
  if (segment.length) segments.push(segment.join(' '));
  return <section aria-label="Risk trend" style={{ marginTop: '1.5rem' }}>
    <h2>Indicated risk trend</h2>
    <p>Higher scores indicate higher risk. Gaps mean no compatible scored PRs. A PR can appear in multiple buckets; bucket counts are not additive.</p>
    <svg viewBox="0 0 600 190" role="img" aria-label="Average indicated risk from 0 to 100" style={{ width: '100%', maxHeight: 260 }}>
      {[0, 50, 100].map(n => <g key={n}><text x="0" y={164 - n * 1.3} fill="currentColor" fontSize="11">{n}</text>
        <line x1="30" x2="580" y1={160 - n * 1.3} y2={160 - n * 1.3} stroke="currentColor" opacity="0.15" /></g>)}
      {segments.map((s, i) => <polyline key={i} data-testid="risk-segment" points={s} fill="none" stroke="var(--accent)" strokeWidth="2" />)}
      {points.map((p, i) => p.averageRisk === null ? null : <circle key={p.start} cx={x(i)} cy={160 - p.averageRisk * 1.3} r="3" fill="var(--accent)">
        <title>{date(p.start)}: {display(p.averageRisk, true)} from {p.scoredPRs} scored PRs</title></circle>)}
      {points.length > 0 && <><text x="35" y="185" fill="currentColor" fontSize="11">{date(points[0].start)}</text>
        <text x="575" y="185" textAnchor="end" fill="currentColor" fontSize="11">{date(points.at(-1)!.start)}</text></>}
    </svg>
    <details><summary>View risk data table</summary><div style={{ overflowX: 'auto' }}><table>
      <thead><tr><th>Bucket start (UTC)</th><th>Average risk</th><th>Scored PRs</th><th>Captured PRs</th></tr></thead>
      <tbody>{points.map(p => <tr key={p.start}><td>{date(p.start)}{p.partialBucket ? ' (partial bucket)' : ''}</td>
        <td>{display(p.averageRisk, true)}</td><td>{p.scoredPRs}</td><td>{p.reviewedPRs}</td></tr>)}</tbody>
    </table></div></details>
  </section>;
}

function Paging({ page, onPage }: { page: Page<unknown>['pagination']; onPage: (page: number) => void }) {
  return <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', margin: '1rem 0' }}>
    <button disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>Previous page</button>
    <span>Page {page.page} of {Math.max(1, page.totalPages)} · {page.total} records</span>
    <button disabled={page.page >= page.totalPages} onClick={() => onPage(page.page + 1)}>Next page</button>
  </div>;
}

export function EngineeringHealth({ refreshKey = 0 }: { refreshKey?: number }) {
  const [range, setRange] = useState('30d'), [bucket, setBucket] = useState('day'), [repositoryId, setRepository] = useState('');
  const [refresh, setRefresh] = useState(0), [data, setData] = useState<EngineeringHealthReport | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState('all'), [reviewPage, setReviewPage] = useState(1), [repoPage, setRepoPage] = useState(1);
  const [reviews, setReviews] = useState<Page<HealthReview> | null>(null), [repos, setRepos] = useState<Page<HealthRepository> | null>(null);
  const [detailError, setDetailError] = useState('');
  const [repositoryOptions, setRepositoryOptions] = useState<{ id: string; fullName: string }[]>([]);
  const snapshotSequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const sequence = ++snapshotSequence.current;
    setLoading(true); setError(''); setData(null); setReviews(null); setRepos(null); setDetailError('');
    const params = new URLSearchParams({ range, bucket }); if (repositoryId) params.set('repositoryId', repositoryId);
    api<EngineeringHealthReport>(`/api/dashboard/engineering-health?${params}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && sequence === snapshotSequence.current) {
        setData(result);
        setRepositoryOptions(previous => repositoryId ? [...new Map([...previous, ...result.repositoryOptions].map(r => [r.id, r])).values()] : result.repositoryOptions);
      } })
      .catch(() => { if (!controller.signal.aborted) setError('Engineering health could not be loaded. Please retry.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, bucket, repositoryId, refresh, refreshKey]);
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    setReviews(null); setRepos(null); setDetailError('');
    const params = new URLSearchParams({ range: data.scope.range, bucket: data.scope.bucket, asOf: data.scope.end, limit: '10' });
    if (data.scope.repositoryId) params.set('repositoryId', data.scope.repositoryId);
    params.set('metric', metric); params.set('page', String(reviewPage));
    const reviewRequest = metric === 'all' && reviewPage === 1 ? Promise.resolve(data.reviews) :
      api<{ reviews: Page<HealthReview> }>(`/api/dashboard/reviews?${params}`, { signal: controller.signal }).then(r => r.reviews);
    params.set('page', String(repoPage));
    const repoRequest = repoPage === 1 ? Promise.resolve(data.repositories) :
      api<{ repositories: Page<HealthRepository> }>(`/api/dashboard/repositories?${params}`, { signal: controller.signal }).then(r => r.repositories);
    Promise.all([reviewRequest, repoRequest]).then(([r, p]) => { if (!controller.signal.aborted) {
      setReviews(r); setRepos(p);
      // Retention or filter changes can remove the last page of a new snapshot.
      if (reviewPage > r.pagination.totalPages) setReviewPage(Math.max(1, r.pagination.totalPages));
      if (repoPage > p.pagination.totalPages) setRepoPage(Math.max(1, p.pagination.totalPages));
    } })
      .catch(() => { if (!controller.signal.aborted) setDetailError('Records could not be loaded. Refresh to retry or renew an expired snapshot.'); });
    return () => controller.abort();
  }, [data, metric, reviewPage, repoPage]);
  function changeScope(update: () => void) {
    setReviewPage(1); setRepoPage(1); setMetric('all');
    update();
  }
  return <section className="glass-card engineering-health" aria-label="Engineering health" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
      <label>Period <select aria-label="Reporting period" value={range} onChange={e => changeScope(() => setRange(e.target.value))}>
        <option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select></label>
      <label>Buckets <select aria-label="Trend buckets" value={bucket} onChange={e => changeScope(() => setBucket(e.target.value))}>
        <option value="day">Daily</option><option value="week">Weekly (Monday UTC)</option></select></label>
      <label>Repository <select aria-label="Repository filter" value={repositoryId} onChange={e => changeScope(() => setRepository(e.target.value))}>
        <option value="">All connected repositories</option>{repositoryOptions.map(r => <option key={r.id} value={r.id}>{r.fullName}</option>)}</select></label>
      <button onClick={() => setRefresh(n => n + 1)}>Refresh health</button>
    </div>
    {loading && <p role="status">Loading engineering health…</p>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p>UTC: {data.scope.start} – {data.scope.end} (end exclusive). Updated {new Date(data.generatedAt).toLocaleString()}.</p>
      {data.coverage.partial && <p role="status">Partial evidence: {data.coverage.capturedPRs} captured PRs, {data.coverage.scoredPRs} scored,
        {' '}{data.coverage.testGapScannedPRs} analyzed for test gaps. {data.coverage.legacyJobsWithoutCompletionDate} legacy reviews have unknown completion dates;
        {' '}{data.coverage.approximatePRs} approximate PRs are excluded. {data.coverage.partialEvidencePRs} captured PRs have incomplete scan or execution evidence.
        {' '}Unavailable is not zero or a passing scan.</p>}
      {data.coverage.queryLimited && <p role="alert">Query limit reached. Narrow the reporting period or repository filter; totals are unavailable.</p>}
      {data.coverage.repositoryListLimited && <p role="status">Repository picker and breakdown are limited to the first 500 repositories.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        {cards.map(([key, label, filter, description]) => <div key={key} className="glass-card" style={{ padding: '1rem' }}>
          {filter ? <button title={description} onClick={() => { setMetric(filter); setReviewPage(1); }}>{label}</button> : <span title={description}>{label}</span>}
          <p style={{ fontSize: '1.7rem', margin: '0.5rem 0' }}>{display(data.metrics[key], key === 'averageRisk')}</p>
          <small>{key === 'averageRisk' ? `${data.coverage.scoredPRs} scored / ${data.coverage.capturedPRs} captured PRs; higher is riskier.` : description}</small>
        </div>)}
      </div>
      <p>{data.comparison.available && data.comparison.percentageChange !== null ?
        `Average indicated PR risk ${data.comparison.percentageChange < 0 ? 'decreased' : data.comparison.percentageChange > 0 ? 'increased' : 'was unchanged'}${data.comparison.percentageChange === 0 ? '' : ` by ${Math.abs(data.comparison.percentageChange).toFixed(1)}%`} versus the previous equal-length period (${data.comparison.currentScoredPRs} vs ${data.comparison.previousScoredPRs} scored PRs). This is not a measured change in overall code quality.` :
        `Risk comparison unavailable: ${data.comparison.reason}`}</p>
      {data.coverage.capturedPRs === 0 && !data.coverage.queryLimited && <p>No precisely dated captured PR reviews in this period. Historical reviews remain available in review history.</p>}
      <RiskChart points={data.trend} />
      <h2>Repository breakdown</h2>
      {repos && <><div style={{ overflowX: 'auto' }}><table><thead><tr><th>Repository</th><th>Captured PRs</th><th>Critical findings</th><th>Security findings</th><th>Average risk</th></tr></thead>
        <tbody>{repos.items.map(r => <tr key={r.id}><td><button onClick={() => changeScope(() => setRepository(r.id))}>{r.fullName}</button></td><td>{display(r.reviewedPRs)}</td>
          <td>{display(r.criticalFindings)}</td><td>{display(r.securityFindings)}</td><td>{display(r.averageRisk, true)} ({r.scoredPRs} scored)</td></tr>)}</tbody></table></div>
        <Paging page={repos.pagination} onPage={setRepoPage} /></>}
      <h2>Supporting reviews · {metric}</h2>
      <button onClick={() => { setMetric('all'); setReviewPage(1); }}>Show all captured PRs</button>
      {detailError && <p role="alert">{detailError}</p>}
      {!reviews && !detailError && <p role="status">Loading supporting records…</p>}
      {reviews && <><div style={{ overflowX: 'auto' }}><table><thead><tr><th>Review</th><th>Completed (UTC)</th><th>Critical</th><th>Security</th><th>Suggested gaps</th><th>Indicated risk</th></tr></thead>
        <tbody>{reviews.items.map(r => <tr key={r.jobId}><td><Link href={`/history?job=${encodeURIComponent(r.jobId)}`}>{r.repository} #{r.referenceId}</Link></td>
          <td>{r.completedAt}</td><td>{r.criticalCount}</td><td>{r.securityCount}</td><td>{display(r.testGapCount)}</td><td>{display(r.riskScore, true)}</td></tr>)}</tbody></table></div>
        {reviews.items.length === 0 && <p>No supporting reviews for this metric in this period.</p>}<Paging page={reviews.pagination} onPage={setReviewPage} /></>}
    </>}
  </section>;
}
