import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/feedback-loop/workflow.service', async importOriginal => ({
  ...await importOriginal<typeof import('../services/feedback-loop/workflow.service')>(), updateWorkflow: vi.fn(), workflowEvents: vi.fn(),
}));
vi.mock('../services/feedback-loop/rule-conversion.service', () => ({ prepareRuleDraft: vi.fn(), createRuleFromFinding: vi.fn() }));
vi.mock('../services/feedback-loop/adaptation.service', () => ({ feedbackInsights: vi.fn(), updateAdaptation: vi.fn() }));
vi.mock('../config/prisma', () => ({ default: {} }));
import { FeedbackLoopController } from './feedback-loop.controller';
import { LoopError, updateWorkflow, workflowEvents } from '../services/feedback-loop/workflow.service';
import { prepareRuleDraft, createRuleFromFinding } from '../services/feedback-loop/rule-conversion.service';
import { feedbackInsights, updateAdaptation } from '../services/feedback-loop/adaptation.service';
import { mockReq, mockRes } from '../test-utils/express-mocks';
const req = () => Object.assign(mockReq({ params: { id: 'job', findingId: 'occ' }, body: { status: 'DISMISSED', expectedRevision: 0, enabled: true } }), { auth: { userId: 'owner' } });
beforeEach(() => { vi.resetAllMocks(); });
describe('feedback-loop HTTP boundary', () => {
  it('passes authenticated identity and complete route scope to the workflow service', async () => {
    vi.mocked(updateWorkflow).mockResolvedValue({ status: 'OPEN', revision: 0 });
    const res = mockRes(); await FeedbackLoopController.workflow(req(), res);
    expect(updateWorkflow).toHaveBeenCalledWith('owner', 'job', 'occ', 'DISMISSED', 0);
    expect(res.json).toHaveBeenCalledWith({ workflow: { status: 'OPEN', revision: 0 } });
  });
  it.each([400, 404, 409])('preserves intentional %i errors', async status => {
    vi.mocked(updateWorkflow).mockRejectedValueOnce(new LoopError(status, 'Safe message'));
    const res = mockRes(); await FeedbackLoopController.workflow(req(), res);
    expect(res.status).toHaveBeenCalledWith(status);
  });
  it.each([
    [FeedbackLoopController.workflow, updateWorkflow], [FeedbackLoopController.events, workflowEvents],
    [FeedbackLoopController.draft, prepareRuleDraft], [FeedbackLoopController.createRule, createRuleFromFinding],
    [FeedbackLoopController.insights, feedbackInsights], [FeedbackLoopController.settings, updateAdaptation],
  ])('sanitizes infrastructure errors without falsely confirming success', async (controller, service) => {
    vi.mocked(service as any).mockRejectedValueOnce(new Error('secret source/API credentials'));
    const res = mockRes(); await controller(req(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('credentials');
  });
});
