import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));
import { FeedbackAdaptationPanel } from './FeedbackAdaptationPanel';
const snapshot = { enabled: false, revision: 0, partial: false, scannedJobs: 5,
  policy: { version: 'feedback_v1', minReviewedPrs: 5, rejectionRatio: 0.8 }, recommendations: [] };
beforeEach(() => { vi.resetAllMocks(); });
describe('opt-in feedback adaptation', () => {
  it('requires opt-in and supports disabling/reset without deleting feedback', async () => {
    const user = userEvent.setup(); mockApi.mockResolvedValueOnce(snapshot);
    render(<FeedbackAdaptationPanel repositoryId="repo" />);
    const enable = await screen.findByRole('button', { name: /Enable feedback adaptation/ }); expect(enable).toBeDisabled();
    await user.click(screen.getByLabelText(/Enable repository-specific/));
    mockApi.mockResolvedValueOnce({ enabled: true, revision: 1 }); await user.click(enable);
    expect(mockApi).toHaveBeenLastCalledWith('/api/repositories/repo/feedback-adaptation', expect.objectContaining({ body: JSON.stringify({ enabled: true, expectedRevision: 0 }) }));
    mockApi.mockResolvedValueOnce({ enabled: false, revision: 2 }); await user.click(await screen.findByRole('button', { name: /Disable \/ reset/ }));
    expect(mockApi).toHaveBeenLastCalledWith('/api/repositories/repo/feedback-adaptation', expect.objectContaining({ body: JSON.stringify({ enabled: false, expectedRevision: 1 }) }));
  });
  it('explains partial evidence and preserves state on a conflict', async () => {
    const user = userEvent.setup(); mockApi.mockResolvedValueOnce({ ...snapshot, enabled: true, partial: true });
    render(<FeedbackAdaptationPanel repositoryId="repo" />);
    expect(await screen.findByText(/Evidence limit reached/)).toBeTruthy();
    mockApi.mockRejectedValueOnce({ status: 409, error: 'Settings changed; refresh' });
    await user.click(screen.getByRole('button', { name: /Disable \/ reset/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings changed');
    expect(screen.getByRole('button', { name: /Disable \/ reset/ })).toBeTruthy();
  });
});
