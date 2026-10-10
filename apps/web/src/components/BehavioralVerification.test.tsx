import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));
import { BehavioralVerification } from './BehavioralVerification';
const report = { version: 1, executor: 'OWNER_CI', scenarios: [{ id: 'a'.repeat(24), filePath: 'cart.ts', description: 'opens cart', stage: 'GENERATED', status: 'NOT_RUN' }] };
beforeEach(() => { vi.clearAllMocks(); mockApi.mockResolvedValue({ report, config: { enabled: true }, runs: [] }); });
describe('behavioral UI', () => {
  it('keeps legacy jobs without behavioral data compatible', () => {
    const view = render(<BehavioralVerification jobId="old" />);
    expect(view.container.textContent).toBe(''); expect(mockApi).not.toHaveBeenCalled();
  });
  it('requires confirmation for the current explicit actions and resets it on edits', async () => {
    const user = userEvent.setup(); render(<BehavioralVerification jobId="job" initialReport={report} />);
    await waitFor(() => expect(mockApi).toHaveBeenCalled());
    const button = screen.getByRole('button', { name: 'Run in owner CI' });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText('Scenario actions JSON')); await user.paste('[{"action":"navigate","path":"/"},{"action":"assertVisible","testId":"cart"}]');
    await user.click(screen.getByLabelText(/I approve executing/));
    expect(button).toBeEnabled();
    await user.type(screen.getByLabelText('GitHub deployment ID'), '42');
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/I approve executing/));
    mockApi.mockResolvedValueOnce({ run: { status: 'QUEUED' } });
    await user.click(button);
    expect(mockApi).toHaveBeenCalledWith('/api/behavioral/jobs/job/runs', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"confirmed":true') }));
  });
  it.each(['FAILED', 'TIMED_OUT', 'ERROR', 'NOT_RUN', 'PASSED'])('renders the recorded %s outcome', async status => {
    const input = { ...report, scenarios: [{ ...report.scenarios[0], status, stage: status === 'PASSED' ? 'VERIFIED' : 'GENERATED' }] };
    mockApi.mockResolvedValue({ report: input, config: null, runs: [] });
    render(<BehavioralVerification jobId="job" initialReport={input} />);
    expect(await screen.findByText(status)).toBeTruthy();
  });
});
