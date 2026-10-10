import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { FindingController } from './finding.controller';
import { RepositoryController } from './repository.controller';
import * as feedbackService from '../services/historical/feedback.service';
import * as occurrenceService from '../services/historical/occurrence.service';

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: {
      findFirst: vi.fn(),
    },
    findingOccurrence: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    repository: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../config/queue', () => ({
  analysisQueue: {
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../services/historical/feedback.service', () => ({
  updateFeedback: vi.fn(),
  getFeedbackEvents: vi.fn(),
  FeedbackConflictError: class FeedbackConflictError extends Error {
    readonly currentRevision: number;
    constructor(currentRevision: number) {
      super(`Feedback conflict: server revision is ${currentRevision}. Fetch and retry.`);
      this.name = 'FeedbackConflictError';
      this.currentRevision = currentRevision;
    }
  },
}));

vi.mock('../services/historical/occurrence.service', () => ({
  getOccurrencesForJob: vi.fn(),
  recordJobFindings: vi.fn(),
}));

function mockReq(overrides: Record<string, any> = {}) {
  return {
    auth: { userId: 'user-1' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('FindingController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listForJob', () => {
    it('returns 404 when job does not exist or user does not own it', async () => {
      (prisma.analysisJob.findFirst as any).mockResolvedValueOnce(null);
      const req = mockReq({ params: { id: 'job-1' } });
      const res = mockRes();

      await FindingController.listForJob(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Job not found or access denied' });
    });

    it('returns isLegacy: true when job has findings in results but 0 occurrences', async () => {
      (prisma.analysisJob.findFirst as any).mockResolvedValueOnce({
        id: 'job-1',
        repositoryId: 'repo-1',
        status: 'COMPLETED',
        results: [{ filePath: 'src/app.ts', issue: 'Legacy issue', suggestion: 'Fix legacy', agentType: 'SECURITY', priority: 'HIGH' }],
      });
      (occurrenceService.getOccurrencesForJob as any).mockResolvedValueOnce([]);

      const req = mockReq({ params: { id: 'job-1' } });
      const res = mockRes();

      await FindingController.listForJob(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          isLegacy: true,
          canSupportFeedback: false,
          findings: [],
        }),
      );
    });

    it('returns list of occurrences with default UNREVIEWED feedback when no feedback row exists', async () => {
      (prisma.analysisJob.findFirst as any).mockResolvedValueOnce({
        id: 'job-1',
        repositoryId: 'repo-1',
        status: 'COMPLETED',
        results: null,
      });

      const createdAt = new Date();
      (occurrenceService.getOccurrencesForJob as any).mockResolvedValueOnce([
        {
          id: 'occ-1',
          filePath: 'src/auth.ts',
          lineNumber: 42,
          category: 'SECURITY',
          severity: 'HIGH',
          source: 'SEMANTIC',
          sources: ['SEMANTIC'],
          ruleKeys: ['no-hardcoded-secret'],
          summary: 'Hardcoded secret detected',
          fingerprint: 'fp_v1_SECURITY:src/auth:123',
          feedback: null,
          createdAt,
        },
      ]);

      const req = mockReq({ params: { id: 'job-1' } });
      const res = mockRes();

      await FindingController.listForJob(req, res);

      expect(res.json).toHaveBeenCalledWith({
        jobId: 'job-1',
        repositoryId: 'repo-1',
        isLegacy: false,
        canSupportFeedback: true,
        findings: [
          {
            id: 'occ-1',
            filePath: 'src/auth.ts',
            lineNumber: 42,
            category: 'SECURITY',
            severity: 'HIGH',
            source: 'SEMANTIC',
            sources: ['SEMANTIC'],
            ruleKeys: ['no-hardcoded-secret'],
            summary: 'Hardcoded secret detected',
            fingerprint: 'fp_v1_SECURITY:src/auth:123',
            feedback: {
              disposition: 'UNREVIEWED',
              rejectionReason: null,
              note: null,
              revision: 0,
              updatedAt: createdAt,
            },
          },
        ],
      });
    });
  });

  describe('updateFeedback', () => {
    it('returns 400 for invalid disposition', async () => {
      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'INVALID' },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid disposition') }),
      );
    });

    it('returns 400 when disposition is REJECTED without rejectionReason', async () => {
      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'REJECTED' },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('rejectionReason is required') }),
      );
    });

    it('returns 400 when disposition is ACCEPTED but carries a rejectionReason', async () => {
      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'ACCEPTED', rejectionReason: 'FALSE_POSITIVE' },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('rejectionReason must not be set') }),
      );
    });

    it('returns 400 when note exceeds 1000 characters', async () => {
      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'ACCEPTED', note: 'x'.repeat(1001) },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'note must not exceed 1000 characters' });
    });

    it('returns 400 when expectedRevision is negative', async () => {
      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'ACCEPTED', expectedRevision: -1 },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'expectedRevision must be a non-negative integer' });
    });

    it('returns 404 when finding is not found or not owned by user', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce(null);

      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-other' },
        body: { disposition: 'ACCEPTED' },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Finding not found or access denied' });
    });

    it('returns 409 when finding is superseded', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce({
        id: 'occ-1',
        superseded: true,
      });

      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'ACCEPTED' },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: 'Cannot update feedback on a superseded finding' });
    });

    it('returns 409 when feedbackService throws FeedbackConflictError', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce({
        id: 'occ-1',
        superseded: false,
      });

      (feedbackService.updateFeedback as any).mockRejectedValueOnce(
        new feedbackService.FeedbackConflictError(5),
      );

      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: { disposition: 'ACCEPTED', expectedRevision: 4 },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Feedback conflict: server revision is 5. Fetch and retry.',
        currentRevision: 5,
      });
    });

    it('returns 200 with updated feedback on successful update', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce({
        id: 'occ-1',
        superseded: false,
      });

      const mockFeedbackResult = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        disposition: 'REJECTED',
        rejectionReason: 'FALSE_POSITIVE',
        note: 'Not applicable here',
        revision: 1,
        updatedAt: new Date(),
      };
      (feedbackService.updateFeedback as any).mockResolvedValueOnce(mockFeedbackResult);

      const req = mockReq({
        params: { id: 'job-1', findingId: 'occ-1' },
        body: {
          disposition: 'REJECTED',
          rejectionReason: 'FALSE_POSITIVE',
          note: 'Not applicable here',
        },
      });
      const res = mockRes();

      await FindingController.updateFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith({ feedback: mockFeedbackResult });
    });
  });

  describe('getFeedbackEvents', () => {
    it('returns 404 when finding is not owned by user', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce(null);
      const req = mockReq({ params: { id: 'job-1', findingId: 'occ-1' } });
      const res = mockRes();

      await FindingController.getFeedbackEvents(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns audit events list', async () => {
      (prisma.findingOccurrence.findFirst as any).mockResolvedValueOnce({ id: 'occ-1' });
      const mockEvents = [
        {
          id: 'evt-1',
          feedbackId: 'fb-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          rejectionReason: null,
          revision: 0,
          createdAt: new Date(),
        },
      ];
      (feedbackService.getFeedbackEvents as any).mockResolvedValueOnce(mockEvents);

      const req = mockReq({ params: { id: 'job-1', findingId: 'occ-1' } });
      const res = mockRes();

      await FindingController.getFeedbackEvents(req, res);

      expect(res.json).toHaveBeenCalledWith({ events: mockEvents });
    });
  });

  describe('backfillLegacyFindings', () => {
    it('returns 400 when job is not COMPLETED', async () => {
      (prisma.analysisJob.findFirst as any).mockResolvedValueOnce({
        id: 'job-1',
        repositoryId: 'repo-1',
        status: 'ANALYZING',
        results: null,
      });

      const req = mockReq({ params: { id: 'job-1' } });
      const res = mockRes();

      await FindingController.backfillLegacyFindings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Only completed jobs can be backfilled' });
    });

    it('backfills findings and returns count', async () => {
      (prisma.analysisJob.findFirst as any).mockResolvedValueOnce({
        id: 'job-1',
        repositoryId: 'repo-1',
        status: 'COMPLETED',
        results: [{ filePath: 'src/main.ts', issue: 'Issue', suggestion: 'Fix', agentType: 'BUG', priority: 'MEDIUM' }],
      });

      const req = mockReq({ params: { id: 'job-1' } });
      const res = mockRes();

      await FindingController.backfillLegacyFindings(req, res);

      expect(occurrenceService.recordJobFindings).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          backfilledCount: 1,
        }),
      );
    });
  });

  describe('RepositoryController settings', () => {
    it('returns 400 when enabled is not boolean', async () => {
      const req = mockReq({ params: { id: 'repo-1' }, body: { enabled: 'yes' } });
      const res = mockRes();

      await RepositoryController.updateHistoricalSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' });
    });

    it('returns 404 when repository not found or not owned', async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce(null);

      const req = mockReq({ params: { id: 'repo-1' }, body: { enabled: true } });
      const res = mockRes();

      await RepositoryController.updateHistoricalSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('updates repository setting and returns updated value', async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce({ id: 'repo-1' });
      (prisma.repository.update as any).mockResolvedValueOnce({
        id: 'repo-1',
        historicalIntelligenceEnabled: true,
      });

      const req = mockReq({ params: { id: 'repo-1' }, body: { enabled: true } });
      const res = mockRes();

      await RepositoryController.updateHistoricalSettings(req, res);

      expect(prisma.repository.update).toHaveBeenCalledWith({
        where: { id: 'repo-1' },
        data: { historicalIntelligenceEnabled: true },
        select: { id: true, historicalIntelligenceEnabled: true },
      });
      expect(res.json).toHaveBeenCalledWith({
        repositoryId: 'repo-1',
        historicalIntelligenceEnabled: true,
      });
    });

    it('gets repository setting', async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce({
        id: 'repo-1',
        historicalIntelligenceEnabled: true,
      });

      const req = mockReq({ params: { id: 'repo-1' } });
      const res = mockRes();

      await RepositoryController.getHistoricalSettings(req, res);

      expect(res.json).toHaveBeenCalledWith({
        repositoryId: 'repo-1',
        historicalIntelligenceEnabled: true,
      });
    });

    it('returns 404 for historical insights if repository not found or not owned', async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce(null);

      const req = mockReq({ params: { id: 'repo-missing' } });
      const res = mockRes();

      await RepositoryController.getHistoricalInsights(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns historical insights for owned repository', async () => {
      (prisma.repository.findFirst as any).mockResolvedValueOnce({ id: 'repo-1' });

      // Mock aggregation.service getRepositoryInsights
      vi.doMock('../services/historical/aggregation.service', () => ({
        getRepositoryInsights: vi.fn().mockResolvedValue({
          repositoryId: 'repo-1',
          historicalIntelligenceEnabled: true,
          patterns: [],
          summary: { totalOccurrences: 0 },
        }),
      }));

      const req = mockReq({ params: { id: 'repo-1' } });
      const res = mockRes();

      await RepositoryController.getHistoricalInsights(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: 'repo-1',
        }),
      );
    });
  });
});
