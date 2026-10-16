import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EngineeringHealthReport } from '../lib/engineering-health';
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));
import { EngineeringHealth, RiskChart } from './EngineeringHealth';

function report(): EngineeringHealthReport {
  return { version: 1, scope: { range: '30d', bucket: 'day', repositoryId: null, start: '2026-09-11T12:00:00.000Z',
    end: '2026-10-11T12:00:00.000Z', previousStart: '2026-08-12T12:00:00.000Z', timezone: 'UTC' }, generatedAt: '2026-10-11T12:00:00Z',
    metrics: { repositories: 1, reviewedPRs: 1, criticalFindings: 2, securityFindings: 3, suggestedTestGaps: null,
      developerReportedFixes: null, averageRisk: null },
    coverage: { capturedPRs: 1, scoredPRs: 0, testGapScannedPRs: 0, partialEvidencePRs: 1, legacyJobsWithoutCompletionDate: 2, approximatePRs: 1,
      unscoredPRs: 1, fixCoverageComplete: false, workflowQueryLimited: false, queryLimited: false, repositoryListLimited: false,
      trackingStartedAt: '2026-10-01T00:00:00Z', partial: true },
    comparison: { available: false, reason: 'Not enough comparable evidence.', currentAverage: null, previousAverage: null,
      currentScoredPRs: 0, previousScoredPRs: 0, percentageChange: null }, trend: [],
    repositories: { items: [{ id: 'repo', fullName: 'owner/repo', reviewedPRs: 1, criticalFindings: 2, securityFindings: 3,
      averageRisk: null, scoredPRs: 0 }], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } },
    repositoryOptions: [{ id: 'repo', fullName: 'owner/repo' }], reviews: { items: [{ jobId: 'job', repositoryId: 'repo', repository: 'owner/repo',
      referenceId: '42', completedAt: '2026-10-10T12:00:00.000Z', criticalCount: 2, securityCount: 3, testGapCount: null,
      riskScore: null, reportedFixed: false }], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } } };
}
let data: EngineeringHealthReport;
beforeEach(() => { vi.clearAllMocks(); data = report(); mockApi.mockImplementation(async (path: string) => {
  if (path.startsWith('/api/dashboard/reviews?')) return { reviews: data.reviews };
  if (path.startsWith('/api/dashboard/repositories?')) return { repositories: data.repositories };
  return data;
}); });

describe('engineering health dashboard', () => {
  it('preserves both pages and the metric when a completion refresh supplies a new snapshot', async () => {
    data.reviews.pagination = { page: 1, limit: 10, total: 30, totalPages: 3 };
    data.repositories.pagination = { page: 1, limit: 10, total: 30, totalPages: 3 };
    mockApi.mockImplementation(async (path: string) => {
      const params = new URL(path, 'http://test').searchParams;
      if (path.startsWith('/api/dashboard/reviews?')) return { reviews: { ...data.reviews, pagination: { ...data.reviews.pagination, page: Number(params.get('page')) } } };
      if (path.startsWith('/api/dashboard/repositories?')) return { repositories: { ...data.repositories, pagination: { ...data.repositories.pagination, page: Number(params.get('page')) } } };
      return data;
    });
    const user = userEvent.setup(); const { rerender } = render(<EngineeringHealth refreshKey={0} />);
    await screen.findByRole('link', { name: 'owner/repo #42' });
    await user.click(screen.getByRole('button', { name: 'Security findings detected' }));
    await screen.findByText('Supporting reviews · security');
    await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]);
    await screen.findByText(/Page 2 of 3/);
    await user.click(screen.getAllByRole('button', { name: 'Next page' })[1]);
    await waitFor(() => expect(screen.getAllByText(/Page 2 of 3/)).toHaveLength(2));
    const checkpoint = mockApi.mock.calls.length;
    const end = '2026-10-11T13:00:00.000Z';
    data = { ...data, scope: { ...data.scope, end } };
    rerender(<EngineeringHealth refreshKey={1} />);
    await waitFor(() => expect(screen.getAllByText(/Page 2 of 3/)).toHaveLength(2));
    const detailCalls = mockApi.mock.calls.slice(checkpoint).map(([path]) => path as string);
    expect(detailCalls.some(path => path.startsWith('/api/dashboard/reviews?') && path.includes('metric=security') && path.includes('page=2') && path.includes(`asOf=${encodeURIComponent(end)}`))).toBe(true);
    expect(detailCalls.some(path => path.startsWith('/api/dashboard/repositories?') && path.includes('page=2') && path.includes(`asOf=${encodeURIComponent(end)}`))).toBe(true);
    await user.selectOptions(screen.getByLabelText('Reporting period'), '7d');
    await waitFor(() => expect(screen.getAllByText(/Page 1 of 3/)).toHaveLength(2));
    expect(screen.getByText('Supporting reviews · all')).toBeInTheDocument();
  });

  it('clamps only a page that disappeared from the refreshed snapshot', async () => {
    data.reviews.pagination = { page: 1, limit: 10, total: 20, totalPages: 2 };
    mockApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/dashboard/reviews?')) return { reviews: { ...data.reviews, pagination: { ...data.reviews.pagination, page: 2 } } };
      return data;
    });
    const user = userEvent.setup(); const { rerender } = render(<EngineeringHealth refreshKey={0} />);
    await screen.findByRole('link', { name: 'owner/repo #42' });
    await user.click(screen.getAllByRole('button', { name: 'Next page' })[1]);
    await screen.findByText(/Page 2 of 2/);
    data = { ...data, reviews: { ...data.reviews, pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } } };
    rerender(<EngineeringHealth refreshKey={1} />);
    await waitFor(() => expect(screen.getAllByText(/Page 1 of 1/)).toHaveLength(2));
    expect(screen.queryByText(/Page 2 of/)).toBeNull();
  });
  it('shows evidence limits, unavailable metrics and exact review links without prevention claims', async () => {
    render(<EngineeringHealth />);
    expect(await screen.findByText(/Partial evidence:/)).toBeInTheDocument();
    const risk = screen.getByRole('button', { name: 'Average indicated PR risk' }).parentElement!;
    expect(within(risk).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Risk comparison unavailable: Not enough comparable evidence/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'owner/repo #42' })).toHaveAttribute('href', '/history?job=job');
    expect(screen.queryByText(/code quality improved/)).toBeNull();
  });
  it('shows a genuine zero score with its denominator, not as a verified pass', async () => {
    data.metrics.averageRisk = 0; data.coverage.scoredPRs = 1;
    render(<EngineeringHealth />);
    expect(await screen.findByText('0.0/100')).toBeInTheDocument();
    expect(screen.getByText(/1 scored \/ 1 captured PRs/)).toBeInTheDocument();
  });
  it('reports only the eligible indicated-risk percentage change', async () => {
    data.comparison = { available: true, reason: null, currentAverage: 30, previousAverage: 40, currentScoredPRs: 20, previousScoredPRs: 18, percentageChange: -25 };
    render(<EngineeringHealth />);
    expect(await screen.findByText(/Average indicated PR risk decreased by 25.0%/)).toHaveTextContent('not a measured change in overall code quality');
  });
  it('loads, reports errors without stale totals and retries explicitly', async () => {
    mockApi.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup(); render(<EngineeringHealth />);
    expect(screen.getByText(/Loading engineering health/)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'PRs reviewed' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh health' }));
    expect(await screen.findByRole('button', { name: 'PRs reviewed' })).toBeInTheDocument();
  });
  it('filters repository, period and bucket using server metrics', async () => {
    const user = userEvent.setup(); render(<EngineeringHealth />); await screen.findByRole('button', { name: 'PRs reviewed' });
    await user.selectOptions(screen.getByLabelText('Reporting period'), '7d');
    await waitFor(() => expect(mockApi.mock.calls.at(-1)![0]).toContain('range=7d'));
    await user.selectOptions(screen.getByLabelText('Trend buckets'), 'week');
    await waitFor(() => expect(mockApi.mock.calls.at(-1)![0]).toContain('bucket=week'));
    await user.selectOptions(screen.getByLabelText('Repository filter'), 'repo');
    await waitFor(() => expect(mockApi.mock.calls.at(-1)![0]).toContain('repositoryId=repo'));
  });
  it('rejects out-of-order responses when changing filters', async () => {
    let oldResolve!: (data: EngineeringHealthReport) => void;
    mockApi.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }));
    const user = userEvent.setup(); render(<EngineeringHealth />);
    const newer = report(); newer.metrics.reviewedPRs = 99; mockApi.mockResolvedValue(newer);
    await user.selectOptions(screen.getByLabelText('Reporting period'), '7d'); await screen.findByText('99');
    await act(async () => oldResolve(data));
    expect(screen.getByText('99')).toBeInTheDocument();
    expect(mockApi.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('drills into metrics and paginates against the same as-of snapshot', async () => {
    data.reviews.pagination = { page: 1, limit: 10, total: 21, totalPages: 3 };
    const user = userEvent.setup(); render(<EngineeringHealth />); await screen.findByRole('link', { name: 'owner/repo #42' });
    await user.click(screen.getByRole('button', { name: 'Security findings detected' }));
    await waitFor(() => expect(mockApi.mock.calls.at(-1)![0]).toContain('metric=security'));
    await screen.findByRole('link', { name: 'owner/repo #42' });
    await user.click(screen.getAllByRole('button', { name: 'Next page' })[1]);
    await waitFor(() => expect(mockApi.mock.calls.at(-1)![0]).toContain('page=2'));
    expect(mockApi.mock.calls.at(-1)![0]).toContain(`asOf=${encodeURIComponent(data.scope.end)}`);
  });
  it('refreshes from a completion signal and preserves explicit empty/limited states', async () => {
    data.coverage.capturedPRs = 0; data.reviews.items = [];
    const { rerender } = render(<EngineeringHealth refreshKey={0} />);
    expect(await screen.findByText(/No precisely dated captured PR reviews/)).toBeInTheDocument();
    data = { ...data, coverage: { ...data.coverage, queryLimited: true } }; rerender(<EngineeringHealth refreshKey={1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Query limit reached');
    expect(mockApi).toHaveBeenCalledTimes(2);
  });
});
describe('accessible risk chart', () => {
  it('does not connect over missing buckets and includes an accessible data table', async () => {
    const points = [30, null, 0].map((value, i) => ({ start: `2026-10-0${i + 1}T00:00:00Z`, end: `2026-10-0${i + 2}T00:00:00Z`,
      averageRisk: value, scoredPRs: value === null ? 0 : 1, reviewedPRs: 1, partialBucket: false }));
    render(<RiskChart points={points} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Average indicated risk from 0 to 100');
    expect(screen.getAllByTestId('risk-segment')).toHaveLength(2);
    await userEvent.setup().click(screen.getByText('View risk data table'));
    expect(screen.getByRole('table')).toHaveTextContent('Unavailable');
    expect(screen.getByRole('table')).toHaveTextContent('0.0/100');
  });
});
