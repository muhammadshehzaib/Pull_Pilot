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

  it('requires confirmation for the current draft contents', async () => {
    mockApi.mockResolvedValueOnce({ drafts: [draft] });
    const user = userEvent.setup();
    render(<TestDraftFlow jobId="job-1" scenario={scenario} />);

    const createButton = await screen.findByRole('button', { name: 'Create test PR' });
    expect(createButton).toBeDisabled();

    const confirmation = screen.getByRole('checkbox');
    await user.click(confirmation);
    expect(createButton).toBeEnabled();

    await user.type(screen.getByLabelText('Test contents'), '\n// reviewed edit');
    await waitFor(() => expect(createButton).toBeDisabled());
  });
});
