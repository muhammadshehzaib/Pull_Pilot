import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const { mockApi, authUser } = vi.hoisted(() => ({ mockApi: vi.fn(), authUser: { id: 'owner', username: 'owner' } }));
vi.mock('../../lib/api', () => ({ api: mockApi }));
vi.mock('../../lib/useAuth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }));
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../../components/BehavioralVerification', () => ({ BehavioralVerification: () => null }));
import HistoryPage from './page';

const f = (findingId: string, priority: 'HIGH' | 'LOW') => ({ findingId, priority, filePath: 'src/auth.ts', lineNumber: 10,
  agentType: 'BUG', issue: `Issue ${findingId}`, suggestion: 'Fix', feedback: { disposition: 'UNREVIEWED', rejectionReason: null, note: null, revision: 0 } });
const summary = { id: 'job-1', eventType: 'PULL_REQUEST', referenceId: '42', status: 'COMPLETED', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), findingCount: 2,
  repository: { id: 'repo-1', fullName: 'owner/repo' } };
let job: any;
let failFeedback: boolean;
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks(); failFeedback = false;
  job = { ...summary, results: [f('low-occ', 'LOW'), f('high-occ', 'HIGH')], metadata: { historicalFeedbackEligible: true,
    historicalMemory: { version: 1, algorithmVersion: 'fp_v2', suppliedPatternIds: ['pattern-1'], patternCount: 1, truncated: false } } };
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/repositories?')) return { repositories: [{ ...summary.repository, isActive: true }], pagination: { totalPages: 1 } };
    if (path.startsWith('/api/jobs?')) return { jobs: [summary], pagination: { page: 1, totalPages: 1, total: 1, limit: 50 } };
    if (path.endsWith('/feedback')) {
      if (failFeedback) throw { status: 500, error: 'Try again' };
      const body = JSON.parse(init!.body as string);
      return { feedback: { disposition: body.disposition, rejectionReason: body.rejectionReason ?? null, note: body.note ?? null, revision: body.expectedRevision + 1 } };
    }
    if (path.endsWith('/workflow')) {
      const body = JSON.parse(init!.body as string);
      return { workflow: { status: body.status, revision: body.expectedRevision + 1 } };
    }
    if (path.endsWith('/findings/backfill')) {
      job = { ...job, results: [f('backfilled-occ', 'HIGH')] }; return { backfilledCount: 1 };
    }
    if (path === '/api/jobs/job-1') return { job };
    if (path.endsWith('/feedback-insights')) return { enabled: false, revision: 0, partial: false, scannedJobs: 0,
      policy: { version: 'feedback_v1', minReviewedPrs: 5, rejectionRatio: 0.8 }, recommendations: [] };
    if (path.endsWith('/historical-insights')) return { historicalIntelligenceEnabled: false, insufficientHistory: true, patterns: [], summary: {
      totalOccurrences: 0, distinctPatternsCount: 0, recurringPatternsCount: 0, acceptedTotal: 0, rejectedTotal: 0, falsePositiveTotal: 0, unreviewedTotal: 0 }, recurringPrThreshold: 3, freshness: new Date().toISOString() };
    if (path.endsWith('/historical-intelligence/settings')) return {};
    throw new Error(`Unexpected test API path: ${path}`);
  });
});
async function open() {
  const user = userEvent.setup(); render(<HistoryPage />);
  await user.click(await screen.findByRole('button', { name: /owner\/repo/i }));
  await screen.findByText('Issue high-occ');
  return user;
}
describe('Phase 8 history page integration', () => {
  it('does not claim history is empty when loading fails and supports retry', async () => {
    const base = mockApi.getMockImplementation()!; let failed = false;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/jobs?') && !failed) { failed = true; return Promise.reject(new Error('offline')); }
      return base(path, init);
    });
    const user = userEvent.setup(); render(<HistoryPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('history could not be loaded');
    expect(screen.queryByText(/No reviews yet/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry reviews' }));
    expect(await screen.findByRole('button', { name: /owner\/repo/i })).toBeInTheDocument();
  });
  it.each([false, true])('shows the stored failure even when saved findings exist: %s', async withFindings => {
    job = { ...job, status: 'FAILED', results: withFindings ? job.results : [], metadata: { error: 'Your AI provider quota is exhausted.' } };
    const user = userEvent.setup(); render(<HistoryPage />);
    await user.click(await screen.findByRole('button', { name: /owner\/repo/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your AI provider quota is exhausted.');
    if (withFindings) expect(screen.getByText('Issue high-occ')).toBeInTheDocument();
  });
  it.each([
    { status: 'TIMEOUT', metadata: { reason: 'worker-heartbeat-expired' }, expected: 'worker heartbeat expired' },
    { status: 'SKIPPED', metadata: { details: 'Monthly private review allowance reached.' }, expected: 'Monthly private review allowance reached.' },
    { status: 'FAILED', metadata: {}, expected: 'No failure reason was recorded' },
  ])('explains $status reviews and missing legacy reasons', async ({ status, metadata, expected }) => {
    job = { ...job, status, results: [], metadata };
    const user = userEvent.setup(); render(<HistoryPage />);
    await user.click(await screen.findByRole('button', { name: /owner\/repo/i }));
    expect(await screen.findByText(new RegExp(expected))).toBeInTheDocument();
  });
  it('reports unavailable dashboard deep links without inventing review data', async () => {
    window.history.replaceState(null, '', '/history?job=deleted');
    try {
      render(<HistoryPage />);
      expect(await screen.findByRole('alert')).toHaveTextContent('review could not be loaded');
      expect(screen.queryByText('Issue high-occ')).toBeNull();
    } finally { window.history.replaceState(null, '', '/history'); }
  });
  it('opens an exact dashboard drilldown even when it is not the selected list row', async () => {
    window.history.replaceState(null, '', '/history?job=job-1');
    try {
      render(<HistoryPage />);
      expect(await screen.findByText('Issue high-occ')).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith('/api/jobs/job-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally { window.history.replaceState(null, '', '/history'); }
  });
  it('shows all five actions, supports dismissal/restore, and keeps deprioritized findings expandable', async () => {
    job.results[0] = { ...job.results[0], adaptation: { policyVersion: 'feedback_v1', reviewedPrs: 5, rejectedPrs: 4, reason: 'STYLE_PREFERENCE' } };
    const user = await open();
    const highCard = screen.getByText('Issue high-occ').closest('.glass-card')! as HTMLElement;
    for (const name of [/Helpful/, /Not useful/, /^Dismiss$/, /^Fix$/, /^Create rule$/]) {
      expect(within(highCard).getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByText('Issue low-occ')).toBeNull();
    await user.click(screen.getByText(/Show deprioritized advisories/));
    expect(await screen.findByText('Issue low-occ')).toBeTruthy();
    await user.click(within(highCard).getByRole('button', { name: /^Dismiss$/ }));
    await waitFor(() => expect(screen.queryByText('Issue high-occ')).toBeNull());
    await user.click(screen.getByLabelText(/Show dismissed findings/));
    const restoredCard = screen.getByText('Issue high-occ').closest('.glass-card')! as HTMLElement;
    await user.click(within(restoredCard).getByRole('button', { name: /Restore finding/ }));
    expect(await within(restoredCard).findByRole('button', { name: /^Dismiss$/ })).toBeTruthy();
    expect(screen.getByText(/Deprioritized by feedback_v1/)).toBeTruthy();
  });
  it('renders feedback attached to stable IDs after severity sorting', async () => {
    const user = await open();
    const high = screen.getByTestId('finding-feedback-high-occ');
    await user.click(within(high).getByRole('button', { name: /Helpful/ }));
    expect(mockApi).toHaveBeenCalledWith('/api/jobs/job-1/findings/high-occ/feedback', expect.objectContaining({ method: 'PUT' }));
    expect(within(screen.getByTestId('finding-feedback-low-occ')).getByText('Unreviewed')).toBeTruthy();
    expect(screen.getByText(/not independent verification/)).toBeTruthy();
  });
  it('opens insights and allows explicit opt-in from the real page', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: /Historical insights/i }));
    expect(await screen.findByTestId('repository-insights-panel')).toBeTruthy();
    const toggle = await screen.findByRole('button', { name: /^Disabled$/i });
    await user.click(toggle);
    expect(mockApi).toHaveBeenCalledWith('/api/repositories/repo-1/historical-intelligence/settings', expect.objectContaining({ method: 'PATCH' }));
  });
  it('preserves legacy findings and explicitly backfills IDs', async () => {
    job.results = [{ ...f('legacy', 'HIGH'), findingId: undefined }]; delete job.metadata.historicalMemory;
    const user = userEvent.setup(); render(<HistoryPage />);
    await user.click(await screen.findByRole('button', { name: /owner\/repo/i }));
    expect(await screen.findByText('Issue legacy')).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalledWith('/api/jobs/job-1/findings/backfill', expect.anything());
    await user.click(screen.getByRole('button', { name: /Enable feedback for this review/i }));
    expect(await screen.findByTestId('finding-feedback-backfilled-occ')).toBeTruthy();
  });
  it('keeps failed feedback retryable and preserves entered notes', async () => {
    const user = await open(); failFeedback = true;
    const high = screen.getByTestId('finding-feedback-high-occ');
    await user.click(within(high).getByRole('button', { name: /Add developer note/ }));
    await user.type(within(high).getByRole('textbox'), 'Keep this note');
    await user.click(within(high).getByRole('button', { name: /Save note/ }));
    await waitFor(() => expect(within(high).getByText('Try again')).toBeTruthy());
    expect((within(high).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this note');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('history request ordering', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late detail %s after selecting another review', async finish => {
    const old = deferred<{ job: typeof job }>();
    const second = { ...summary, id: 'job-2', repository: { id: 'repo-2', fullName: 'owner/second' } };
    const base = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/jobs?')) return Promise.resolve({ jobs: [summary, second], pagination: { page: 1, totalPages: 1, total: 2 } });
      if (path === '/api/jobs/job-1') return old.promise;
      if (path === '/api/jobs/job-2') return Promise.resolve({ job: { ...job, ...second, results: [f('second', 'HIGH')] } });
      return base(path, init);
    });
    const user = userEvent.setup(); render(<HistoryPage />);
    await user.click(await screen.findByRole('button', { name: /owner\/repo/i }));
    await user.click(screen.getByRole('button', { name: /owner\/second/i }));
    expect(await screen.findByText('Issue second')).toBeInTheDocument();
    await act(async () => { if (finish === 'resolve') old.resolve({ job }); else old.reject(new Error('old failure')); });
    expect(screen.getByText('Issue second')).toBeInTheDocument();
    expect(screen.queryByText('Issue high-occ')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['page', 'filter'])('ignores an old poll and its loading state during a %s change', async navigation => {
    vi.useFakeTimers();
    const poll = deferred<any>(); const next = deferred<any>();
    const active = { ...summary, status: 'ANALYZING' };
    const other = { ...summary, id: 'job-2', repository: { id: 'repo-2', fullName: 'owner/second' } };
    let calls = 0;
    mockApi.mockImplementation((path: string) => {
      if (path.startsWith('/api/repositories?')) return Promise.resolve({ repositories: [{ ...active.repository, isActive: true }, { ...other.repository, isActive: true }], pagination: { totalPages: 1 } });
      if (!path.startsWith('/api/jobs?')) throw new Error(path);
      if (++calls === 1) return Promise.resolve({ jobs: [active, other], pagination: { page: 1, totalPages: 2, total: 51 } });
      if (calls === 2) return poll.promise;
      return next.promise;
    });
    render(<HistoryPage />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    if (navigation === 'page') fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    else fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo-2' } });
    await act(async () => poll.resolve({ jobs: [active], pagination: { page: 1, totalPages: 2, total: 51 } }));
    expect(screen.queryByRole('button', { name: /owner\/repo/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await act(async () => next.resolve({ jobs: [other], pagination: { page: navigation === 'page' ? 2 : 1, totalPages: 2, total: 51 } }));
    expect(screen.getByRole('button', { name: /owner\/second/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /owner\/repo/i })).toBeNull();
    expect(mockApi.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('does not reopen the old selection when a background detail refresh finishes late', async () => {
    vi.useFakeTimers();
    const refresh = deferred<any>();
    const second = { ...summary, id: 'job-2', repository: { id: 'repo-2', fullName: 'owner/second' } };
    let lists = 0, details = 0;
    const base = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/jobs?')) return Promise.resolve({ jobs: [{ ...summary, status: ++lists === 1 ? 'ANALYZING' : 'COMPLETED' }, second], pagination: { page: 1, totalPages: 1, total: 2 } });
      if (path === '/api/jobs/job-1') return ++details === 1 ? Promise.resolve({ job: { ...job, status: 'ANALYZING' } }) : refresh.promise;
      if (path === '/api/jobs/job-2') return Promise.resolve({ job: { ...job, ...second, results: [f('second', 'HIGH')] } });
      return base(path, init);
    });
    render(<HistoryPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /owner\/repo/i }));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(details).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /owner\/second/i }));
    await act(async () => {});
    await act(async () => refresh.resolve({ job }));
    expect(screen.getByText('Issue second')).toBeInTheDocument();
    expect(screen.queryByText('Issue high-occ')).toBeNull();
  });
});

describe('history repository filters', () => {
  it('lists later-page and disconnected repositories before visiting their review history', async () => {
    const base = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/repositories?limit=100&page=1') return Promise.resolve({ repositories: [{ ...summary.repository, isActive: true }], pagination: { totalPages: 2 } });
      if (path === '/api/repositories?limit=100&page=2') return Promise.resolve({ repositories: [{ id: 'older', fullName: 'owner/older', isActive: false }], pagination: { totalPages: 2 } });
      return base(path, init);
    });
    const user = userEvent.setup(); render(<HistoryPage />);
    await screen.findByRole('option', { name: 'owner/older' });
    await user.selectOptions(screen.getByLabelText('Repository'), 'older');
    await waitFor(() => expect(mockApi.mock.calls.some(([path]) => path.startsWith('/api/jobs?') && path.includes('repositoryId=older'))).toBe(true));
    expect(screen.getByRole('option', { name: 'owner/repo' })).toBeInTheDocument();
  });
  it('keeps history usable while filter loading fails and provides a separate retry', async () => {
    const base = mockApi.getMockImplementation()!; let failed = false;
    mockApi.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/repositories?') && !failed) { failed = true; return Promise.reject(new Error('offline')); }
      return base(path, init);
    });
    const user = userEvent.setup(); render(<HistoryPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository filters could not be loaded');
    expect(await screen.findByRole('button', { name: /owner\/repo/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry repository filters' }));
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
