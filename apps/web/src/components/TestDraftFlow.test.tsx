import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mockApi }));

import { TestDraftFlow } from './TestDraftFlow';
import type { TestDraft } from '../lib/testDraft';
import type { TestGapScenario } from '../lib/testGap';

const scenario: TestGapScenario = {
  filePath: 'src/payment.ts',
  lineNumber: 12,
  scenario: 'does not charge twice for duplicate callbacks',
  expected: 'the payment is applied once',
  confidence: 'HIGH',
};

const draft: TestDraft = {
  id: 'draft-1',
  repositoryId: 'repo-1',
  analysisJobId: 'job-1',
  scenario,
  sourcePath: scenario.filePath,
  targetPath: 'src/payment.test.ts',
  targetContent: 'it("applies a payment once", async () => {});',
  framework: 'vitest',
  notes: null,
  structuralNote: null,
  baseBranch: 'main',
  baseSha: 'base-sha',
  sourcePrNumber: 21,
  status: 'DRAFT',
  branchName: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  error: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('TestDraftFlow', () => {
  it('restores a saved draft for the scenario after reload', async () => {
    mockApi.mockResolvedValueOnce({ drafts: [draft] });
    render(<TestDraftFlow jobId="job-1" scenario={scenario} />);

    expect(await screen.findByDisplayValue('src/payment.test.ts')).toBeTruthy();
    expect(screen.getByDisplayValue(draft.targetContent)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate test draft' })).toBeNull();
    expect(mockApi).toHaveBeenCalledWith('/api/jobs/job-1/test-drafts');
  });

  it('downloads the current edited contents without creating a branch or PR', async () => {
    mockApi.mockResolvedValueOnce({ drafts: [draft] });
    const blobs: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(blob => { blobs.push(blob as Blob); return 'blob:draft'; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<TestDraftFlow jobId="job-1" scenario={scenario} />);
    try {
      const download = await screen.findByRole('button', { name: 'Download draft' });
      expect(screen.queryByRole('button', { name: 'Create test PR' })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      await user.type(screen.getByLabelText('Test contents'), '\n// reviewed edit');
      await user.click(download);
      expect(click).toHaveBeenCalledOnce();
      expect(await blobs[0].text()).toContain('// reviewed edit');
      expect(mockApi).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:draft'));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      click.mockRestore();
    }
  });
});
