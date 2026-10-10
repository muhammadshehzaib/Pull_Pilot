import type { Request, Response } from 'express';
import { LoopError, updateWorkflow, workflowEvents } from '../services/feedback-loop/workflow.service';
import { prepareRuleDraft, createRuleFromFinding } from '../services/feedback-loop/rule-conversion.service';
import { feedbackInsights, updateAdaptation } from '../services/feedback-loop/adaptation.service';

function endpoint(run: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { return res.json(await run(req)); }
    catch (err) {
      if (err instanceof LoopError) return res.status(err.status).json({ error: err.message });
      return res.status(503).json({ error: 'Operation unavailable; your changes were not confirmed. Reload and retry.' });
    }
  };
}
export const FeedbackLoopController = {
  workflow: endpoint(async req => ({ workflow: await updateWorkflow(req.auth!.userId,
    String(req.params.id), String(req.params.findingId), req.body?.status, req.body?.expectedRevision) })),
  events: endpoint(async req => ({ events: await workflowEvents(req.auth!.userId, String(req.params.id), String(req.params.findingId)) })),
  draft: endpoint(req => prepareRuleDraft(req.auth!.userId, String(req.params.id), String(req.params.findingId))),
  createRule: endpoint(req => createRuleFromFinding(req.auth!.userId, String(req.params.id), String(req.params.findingId), req.body ?? {})),
  insights: endpoint(req => feedbackInsights(String(req.params.id), req.auth!.userId)),
  settings: endpoint(req => updateAdaptation(String(req.params.id), req.auth!.userId, req.body?.enabled, req.body?.expectedRevision)),
};
