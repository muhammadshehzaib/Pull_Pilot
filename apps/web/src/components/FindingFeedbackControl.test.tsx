import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));

import { FindingFeedbackControl } from './FindingFeedbackControl';

describe('FindingFeedbackControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders legacy notice and makes no API calls when isLegacy is true', () => {
    const view = render(<FindingFeedbackControl jobId="job-1" findingId="occ-1" isLegacy={true} />);
    expect(view.container.textContent).toContain('Legacy review');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('renders legacy notice when findingId is missing', () => {
    const view = render(<FindingFeedbackControl jobId="job-1" />);
    expect(view.container.textContent).toContain('Legacy review');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('renders initial Unreviewed state and allows accepting finding', async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce({
      feedback: {
        id: 'fb-1',
        disposition: 'ACCEPTED',
        rejectionReason: null,
        note: null,
        revision: 1,
      },
    });

    render(
      <FindingFeedbackControl
        jobId="job-1"
        findingId="occ-1"
        initialFeedback={{
          disposition: 'UNREVIEWED',
          rejectionReason: null,
          note: null,
          revision: 0,
        }}
      />,
    );

    expect(screen.getByText('Unreviewed')).toBeTruthy();
    const acceptBtn = screen.getByRole('button', { name: /Helpful/i });
    await user.click(acceptBtn);

    expect(mockApi).toHaveBeenCalledWith(
      '/api/jobs/job-1/findings/occ-1/feedback',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          disposition: 'ACCEPTED',
          expectedRevision: 0,
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Accepted/i)).toBeTruthy();
      expect(screen.getByText(/Feedback saved/i)).toBeTruthy();
    });
  });

  it('opens rejection reasons, selects a reason and submits', async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce({
      feedback: {
        id: 'fb-1',
        disposition: 'REJECTED',
        rejectionReason: 'INTENDED_BEHAVIOR',
        note: null,
        revision: 1,
      },
    });

    render(
      <FindingFeedbackControl
        jobId="job-1"
        findingId="occ-1"
        initialFeedback={{
          disposition: 'UNREVIEWED',
          rejectionReason: null,
          note: null,
          revision: 0,
        }}
      />,
    );

    const rejectBtn = screen.getByRole('button', { name: /Not useful/i });
    await user.click(rejectBtn);

    expect(screen.getByText('Select Rejection Reason:')).toBeTruthy();
    const intendedRadio = screen.getByLabelText(/Intended Behavior/i);
    await user.click(intendedRadio);

    const confirmBtn = screen.getByRole('button', { name: /Confirm Rejection/i });
    await user.click(confirmBtn);

    expect(mockApi).toHaveBeenCalledWith(
      '/api/jobs/job-1/findings/occ-1/feedback',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          disposition: 'REJECTED',
          rejectionReason: 'INTENDED_BEHAVIOR',
          expectedRevision: 0,
        }),
      }),
    );
  });

  it('allows resetting feedback to unreviewed', async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce({
      feedback: {
        id: 'fb-1',
        disposition: 'UNREVIEWED',
        rejectionReason: null,
        note: null,
        revision: 2,
      },
    });

    render(
      <FindingFeedbackControl
        jobId="job-1"
        findingId="occ-1"
        initialFeedback={{
          disposition: 'ACCEPTED',
          rejectionReason: null,
          note: null,
          revision: 1,
        }}
      />,
    );

    const resetBtn = screen.getByRole('button', { name: /Reset/i });
    await user.click(resetBtn);

    expect(mockApi).toHaveBeenCalledWith(
      '/api/jobs/job-1/findings/occ-1/feedback',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          disposition: 'UNREVIEWED',
          expectedRevision: 1,
        }),
      }),
    );
  });

  it('displays conflict message on 409 conflict error', async () => {
    const user = userEvent.setup();
    mockApi.mockRejectedValueOnce({
      status: 409,
      error: 'Conflict: server revision is 2.',
    });

    render(
      <FindingFeedbackControl
        jobId="job-1"
        findingId="occ-1"
        initialFeedback={{
          disposition: 'UNREVIEWED',
          rejectionReason: null,
          note: null,
          revision: 0,
        }}
      />,
    );

    const acceptBtn = screen.getByRole('button', { name: /Helpful/i });
    await user.click(acceptBtn);

    await waitFor(() => {
      expect(screen.getByText(/Conflict: feedback was modified in another session/i)).toBeTruthy();
    });
  });

  it('loads and displays audit history when history button is clicked', async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce({
      events: [
        {
          id: 'evt-1',
          feedbackId: 'fb-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          rejectionReason: null,
          revision: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(
      <FindingFeedbackControl
        jobId="job-1"
        findingId="occ-1"
        initialFeedback={{
          disposition: 'ACCEPTED',
          rejectionReason: null,
          note: null,
          revision: 0,
        }}
      />,
    );

    const historyBtn = screen.getByRole('button', { name: /History/i });
    await user.click(historyBtn);

    expect(mockApi).toHaveBeenCalledWith('/api/jobs/job-1/findings/occ-1/feedback/events');
    await waitFor(() => {
      expect(screen.getByText('Audit History:')).toBeTruthy();
      expect(screen.getByText(/rev 0:/i)).toBeTruthy();
    });
  });
});
