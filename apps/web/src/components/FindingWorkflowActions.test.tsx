import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiSuggestion } from '../lib/review';
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));
import { FindingWorkflowActions } from './FindingWorkflowActions';
const finding: AiSuggestion = { findingId: 'occ', filePath: 'src/a.ts', lineNumber: 10, agentType: 'STYLE', priority: 'LOW',
  issue: 'Naming mismatch', suggestion: 'Use existing naming', workflow: { status: 'OPEN', revision: 0 } };
const proposal = { creationKey: 'key', repositoryId: 'repo', similarRules: [], draft: { name: 'Naming', description: 'Finding-derived',
  guideline: 'Use existing naming', category: 'STYLE', severity: 'LOW', enforcement: 'LLM', pattern: null, enabled: false } };
beforeEach(() => { vi.resetAllMocks(); });
describe('finding workflow actions', () => {
  it('dismisses independently, and restores with the workflow revision', async () => {
    const user = userEvent.setup(); const changed = vi.fn();
    mockApi.mockResolvedValueOnce({ workflow: { status: 'DISMISSED', revision: 1 } });
    const view = render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={changed} onReload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Dismiss$/ }));
    expect(mockApi).toHaveBeenCalledWith('/api/jobs/job/findings/occ/workflow', expect.objectContaining({
      body: JSON.stringify({ status: 'DISMISSED', expectedRevision: 0 }),
    }));
    expect(changed).toHaveBeenCalledWith({ status: 'DISMISSED', revision: 1 });
    view.rerender(<FindingWorkflowActions jobId="job" finding={{ ...finding, workflow: { status: 'DISMISSED', revision: 1 } }} onChanged={changed} onReload={vi.fn()} />);
    mockApi.mockResolvedValueOnce({ workflow: { status: 'OPEN', revision: 2 } });
    await user.click(screen.getByRole('button', { name: /Restore finding/ }));
    expect(JSON.parse(mockApi.mock.calls[1][1].body)).toEqual({ status: 'OPEN', expectedRevision: 1 });
  });
  it('shows fix guidance and marks a reported fix without execution or a feedback vote', async () => {
    const user = userEvent.setup(); const changed = vi.fn();
    mockApi.mockResolvedValue({ workflow: { status: 'REPORTED_FIXED', revision: 1 } });
    render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={changed} onReload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Fix$/ }));
    expect(screen.getByText(/no code is executed/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Copy fix instructions/ }));
    expect(await screen.findByRole('button', { name: /Fix instructions copied/ })).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Mark fixed/ }));
    expect(changed).toHaveBeenCalledWith({ status: 'REPORTED_FIXED', revision: 1 });
    expect(mockApi.mock.calls.every(([path]) => !path.endsWith('/feedback'))).toBe(true);
  });
  it('requires explicit confirmation, preserves edits on failure, then safely retries', async () => {
    const user = userEvent.setup(); mockApi.mockResolvedValueOnce(structuredClone(proposal));
    render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={vi.fn()} onReload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Create rule$/ }));
    const save = await screen.findByRole('button', { name: /Save repository rule/ });
    expect((save as HTMLButtonElement).disabled).toBe(true); expect(mockApi).toHaveBeenCalledTimes(1);
    const guideline = screen.getByLabelText('Guideline'); await user.clear(guideline); await user.type(guideline, 'Use approved conventions');
    expect((screen.getByLabelText(/Enable for future reviews/) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByLabelText(/I reviewed this repository-wide rule/));
    mockApi.mockRejectedValueOnce({ status: 503, error: 'Retry safely' }); await user.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry safely');
    expect((guideline as HTMLTextAreaElement).value).toBe('Use approved conventions');
    mockApi.mockResolvedValueOnce({ rule: { id: 'rule' }, reused: true }); await user.click(save);
    expect(await screen.findByText(/Repository rule saved/)).toBeTruthy();
    const body = JSON.parse(mockApi.mock.calls[2][1].body);
    expect(body).toMatchObject({ guideline: 'Use approved conventions', confirmed: true, enabled: false, creationKey: 'key', enforcement: 'LLM' });
  });
  it('discarding the proposal performs no persistent rule write', async () => {
    const user = userEvent.setup(); mockApi.mockResolvedValueOnce(structuredClone(proposal));
    render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={vi.fn()} onReload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Create rule$/ }));
    await user.click(await screen.findByRole('button', { name: /Discard rule draft/ }));
    expect(screen.queryByRole('form')).toBeNull(); expect(mockApi).toHaveBeenCalledTimes(1);
  });
  it('offers explicit reload on conflicts and displays bounded audit records', async () => {
    const user = userEvent.setup(); const reload = vi.fn(); mockApi.mockRejectedValueOnce({ status: 409, error: 'Workflow changed' });
    render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={vi.fn()} onReload={reload} />);
    await user.click(screen.getByRole('button', { name: /^Dismiss$/ }));
    await user.click(await screen.findByRole('button', { name: /Reload review/ })); expect(reload).toHaveBeenCalledOnce();
    mockApi.mockResolvedValueOnce({ events: [{ id: 'event', fromStatus: 'OPEN', status: 'DISMISSED', revision: 1 }] });
    await user.click(screen.getByRole('button', { name: /Workflow history/ }));
    expect(await screen.findByText('rev 1: OPEN → DISMISSED')).toBeTruthy();
  });
  it('prevents duplicate submissions and keeps legacy records readable', async () => {
    const user = userEvent.setup(); let finish!: (v: unknown) => void;
    mockApi.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<FindingWorkflowActions jobId="job" finding={finding} onChanged={vi.fn()} onReload={vi.fn()} />);
    await user.dblClick(screen.getByRole('button', { name: /^Dismiss$/ })); expect(mockApi).toHaveBeenCalledTimes(1);
    finish({ workflow: { status: 'DISMISSED', revision: 1 } }); await waitFor(() => expect(screen.getByRole('button', { name: /^Dismiss$/ })).not.toBeDisabled());
    view.rerender(<FindingWorkflowActions jobId="job" finding={{ ...finding, findingId: undefined }} onChanged={vi.fn()} onReload={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
