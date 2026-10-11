import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentDeliveryCard } from './CommentDeliveryCard';
import { api } from '../lib/api';
vi.mock('../lib/api', () => ({ api: vi.fn() }));
const report = { version: 1, expected: 5, delivered: 3, rejected: 1, omitted: 0, pending: 0, unconfirmed: 1, summary: 'WAITING' };
beforeEach(() => vi.resetAllMocks());
describe('comment delivery', () => {
  it('shows counts and uncertainty without claiming completion', () => {
    render(<CommentDeliveryCard jobId="j" report={report} />);
    expect(screen.getByText('3 of 5 inline comments delivered.')).toBeTruthy();
    expect(screen.getByText(/will not be posted again automatically/)).toBeTruthy();
    expect(screen.getByText(/Findings remain available/)).toBeTruthy();
  });
  it('explains disconnect omissions without calling them a changed PR head', () => {
    render(<CommentDeliveryCard jobId="j" report={{ ...report, omitted: 1, unconfirmed: 0, summary: 'OMITTED', repositoryDisconnected: true }} />);
    expect(screen.getByText('Summary: Omitted because the repository was disconnected.')).toBeTruthy();
    expect(screen.getByText('1 inline comment(s) omitted because the repository was disconnected.')).toBeTruthy();
    expect(screen.queryByText(/PR head changed/)).toBeNull();
  });
  it.each([undefined, {}, { ...report, version: 2 }, { ...report, expected: -1 }])('handles legacy or malformed reports', value => {
    render(<CommentDeliveryCard jobId="j" report={value} />);
    expect(screen.getByText(/was not tracked/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('checks existing comments and refreshes the receipt report', async () => {
    vi.mocked(api).mockResolvedValue({ commentDelivery: { ...report, delivered: 4, unconfirmed: 0 } });
    render(<CommentDeliveryCard jobId="j" report={report} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('4 of 5 inline comments delivered.')).toBeTruthy());
    expect(api).toHaveBeenCalledWith('/api/jobs/j/comments/reconcile', { method: 'POST' });
    expect(screen.getByRole('status').textContent).toContain('No new comments were posted');
  });
  it('reports an unsuccessful check without implying a resend', async () => {
    vi.mocked(api).mockRejectedValue(new Error('offline'));
    render(<CommentDeliveryCard jobId="j" report={report} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not be checked'));
  });
});
