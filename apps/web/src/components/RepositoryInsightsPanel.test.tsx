import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));

import { RepositoryInsightsPanel } from './RepositoryInsightsPanel';

const mockInsights = {
  repositoryId: 'repo-1',
  historicalIntelligenceEnabled: true,
  freshness: new Date().toISOString(),
  insufficientHistory: false,
  recurringPrThreshold: 3,
  summary: {
    totalOccurrences: 12,
    distinctPatternsCount: 2,
    recurringPatternsCount: 1,
    acceptedTotal: 8,
    rejectedTotal: 2,
    falsePositiveTotal: 1,
    unreviewedTotal: 2,
  },
  patterns: [
    {
      id: 'pat-1',
      fingerprint: 'fp_v1_SECURITY:auth:1',
      algorithmVersion: 'fp_v1',
      category: 'SECURITY',
      source: 'SEMANTIC',
      summary: 'Hardcoded secret token',
      occurrenceCount: 6,
      distinctPrCount: 4,
      acceptedCount: 5,
      rejectedCount: 1,
      unreviewedCount: 0,
      rejectionReasons: { FALSE_POSITIVE: 1 },
      representativePaths: ['src/auth/jwt.ts'],
      isRecurring: true,
      firstObservedAt: '2026-01-01T00:00:00.000Z',
      lastObservedAt: '2026-02-01T00:00:00.000Z',
      aggregatedAt: '2026-02-01T00:00:00.000Z',
    },
  ],
};

describe('RepositoryInsightsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state then displays summary and patterns', async () => {
    mockApi.mockResolvedValueOnce(mockInsights);

    render(
      <RepositoryInsightsPanel
        repositoryId="repo-1"
        repositoryName="owner/repo"
      />,
    );

    expect(screen.getByText(/Analyzing repository history/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Historical Intelligence & Insights')).toBeTruthy();
      expect(screen.getByText('Hardcoded secret token')).toBeTruthy();
      expect(screen.getByText('SECURITY')).toBeTruthy();
      expect(screen.getByText(/4 distinct PR\(s\)/i)).toBeTruthy();
      expect(screen.getByText('src/auth/jwt.ts')).toBeTruthy();
      expect(screen.getByText(/5 accepted/i)).toBeTruthy();
      expect(screen.getByText(/1 rejected/i)).toBeTruthy();
    });

    expect(mockApi).toHaveBeenCalledWith('/api/repositories/repo-1/historical-insights');
  });

  it('displays insufficient history state when insufficientHistory is true', async () => {
    mockApi.mockResolvedValueOnce({
      ...mockInsights,
      insufficientHistory: true,
      summary: { ...mockInsights.summary, recurringPatternsCount: 0 },
      patterns: [],
    });

    render(<RepositoryInsightsPanel repositoryId="repo-1" />);

    await waitFor(() => {
      expect(screen.getByText('Collecting Historical Patterns')).toBeTruthy();
      expect(screen.getByText(/at least/i)).toBeTruthy();
      expect(screen.getByText(/3 distinct pull requests/i)).toBeTruthy();
    });
  });

  it('toggles historical intelligence setting when switch is clicked', async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce(mockInsights);

    render(<RepositoryInsightsPanel repositoryId="repo-1" />);

    await waitFor(() => {
      expect(screen.getByText('✓ Enabled')).toBeTruthy();
    });

    mockApi.mockResolvedValueOnce({ success: true });

    const toggleBtn = screen.getByRole('button', { name: /Enabled/i });
    await user.click(toggleBtn);

    expect(mockApi).toHaveBeenCalledWith(
      '/api/repositories/repo-1/historical-intelligence/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    mockApi.mockResolvedValueOnce(mockInsights);

    render(<RepositoryInsightsPanel repositoryId="repo-1" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText('Historical Intelligence & Insights')).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);

    expect(handleClose).toHaveBeenCalled();
  });
});
