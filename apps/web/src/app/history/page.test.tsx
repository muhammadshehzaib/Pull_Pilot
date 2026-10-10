import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
beforeEach(() => {
  vi.clearAllMocks(); failFeedback = false;
  job = { ...summary, results: [f('low-occ', 'LOW'), f('high-occ', 'HIGH')], metadata: { historicalFeedbackEligible: true,
    historicalMemory: { version: 1, algorithmVersion: 'fp_v2', suppliedPatternIds: ['pattern-1'], patternCount: 1, truncated: false } } };
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
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
      expect(mockApi).toHaveBeenCalledWith('/api/jobs/job-1');
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
