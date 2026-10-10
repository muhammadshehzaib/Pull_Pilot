import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../config/prisma';

vi.mock('../../config/prisma', () => ({
  default: {
    analysisJob: {
      findMany: vi.fn(),
    },
    findingOccurrence: {
      findMany: vi.fn(),
    },
    historicalPattern: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    repository: {
      findUnique: vi.fn(),
    },
  },
}));

import {
  aggregateRepositoryPatterns,
  getRepositoryInsights,
} from './aggregation.service';

describe('aggregation.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('aggregateRepositoryPatterns', () => {
    it('returns zeroes and deletes stale patterns if no completed jobs in window', async () => {
      (prisma.analysisJob.findMany as any).mockResolvedValueOnce([]);

      const result = await aggregateRepositoryPatterns('repo-1');

      expect(result.totalOccurrences).toBe(0);
      expect(result.distinctPatternsCount).toBe(0);
      expect(prisma.historicalPattern.deleteMany).toHaveBeenCalledWith({
        where: { repositoryId: 'repo-1', algorithmVersion: 'fp_v1' },
      });
    });

    it('aggregates occurrences with distinct-PR counting and feedback accounting', async () => {
      // 3 jobs: PR #10 (analyzed twice), PR #11 (analyzed once)
      const candidateJobs = [
        { id: 'job-1', eventType: 'PULL_REQUEST', referenceId: '10', createdAt: new Date() },
        { id: 'job-2', eventType: 'PULL_REQUEST', referenceId: '10', createdAt: new Date() },
        { id: 'job-3', eventType: 'PULL_REQUEST', referenceId: '11', createdAt: new Date() },
      ];
      (prisma.analysisJob.findMany as any).mockResolvedValueOnce(candidateJobs);

      const occurrences = [
        // From job-1 (PR #10)
        {
          id: 'occ-1',
          analysisJobId: 'job-1',
          fingerprint: 'fp_v1_SECURITY:auth:1',
          category: 'SECURITY',
          source: 'SEMANTIC',
          summary: 'Hardcoded secret in auth',
          filePath: 'src/auth.ts',
          createdAt: new Date('2026-01-01'),
          feedback: { disposition: 'ACCEPTED', rejectionReason: null },
          analysisJob: candidateJobs[0],
        },
        // From job-2 (PR #10 retry/re-analysis) -> same fingerprint, same PR #10
        {
          id: 'occ-2',
          analysisJobId: 'job-2',
          fingerprint: 'fp_v1_SECURITY:auth:1',
          category: 'SECURITY',
          source: 'SEMANTIC',
          summary: 'Hardcoded secret in auth',
          filePath: 'src/auth.ts',
          createdAt: new Date('2026-01-02'),
          feedback: { disposition: 'ACCEPTED', rejectionReason: null },
          analysisJob: candidateJobs[1],
        },
        // From job-3 (PR #11) -> same fingerprint, second distinct PR
        {
          id: 'occ-3',
          analysisJobId: 'job-3',
          fingerprint: 'fp_v1_SECURITY:auth:1',
          category: 'SECURITY',
          source: 'SEMANTIC',
          summary: 'Hardcoded secret in auth',
          filePath: 'src/auth.ts',
          createdAt: new Date('2026-01-03'),
          feedback: { disposition: 'REJECTED', rejectionReason: 'FALSE_POSITIVE' },
          analysisJob: candidateJobs[2],
        },
      ];
      (prisma.findingOccurrence.findMany as any).mockResolvedValueOnce(occurrences);

      const summary = await aggregateRepositoryPatterns('repo-1');

      expect(summary.totalOccurrences).toBe(3);
      expect(summary.distinctPatternsCount).toBe(1);
      expect(summary.acceptedTotal).toBe(2);
      expect(summary.rejectedTotal).toBe(1);
      expect(summary.falsePositiveTotal).toBe(1);

      // Verify distinct PR count is 2 (PR #10 and PR #11), NOT 3
      expect(prisma.historicalPattern.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint_algorithmVersion: {
              repositoryId: 'repo-1',
              fingerprint: 'fp_v1_SECURITY:auth:1',
              algorithmVersion: 'fp_v1',
            },
          },
          create: expect.objectContaining({
            distinctPrCount: 2,
            occurrenceCount: 3,
            acceptedCount: 2,
            rejectedCount: 1,
            rejectionReasons: { FALSE_POSITIVE: 1 },
          }),
        }),
      );
    });

    it('identifies recurring patterns when distinct PR count meets threshold', async () => {
      const candidateJobs = [
        { id: 'job-1', eventType: 'PULL_REQUEST', referenceId: '1', createdAt: new Date() },
        { id: 'job-2', eventType: 'PULL_REQUEST', referenceId: '2', createdAt: new Date() },
        { id: 'job-3', eventType: 'PULL_REQUEST', referenceId: '3', createdAt: new Date() },
      ];
      (prisma.analysisJob.findMany as any).mockResolvedValueOnce(candidateJobs);

      const occurrences = candidateJobs.map((j, i) => ({
        id: `occ-${i}`,
        analysisJobId: j.id,
        fingerprint: 'fp_v1_BUG:null-check:1',
        category: 'BUG',
        source: 'LLM',
        summary: 'Missing null check',
        filePath: `src/file${i}.ts`,
        createdAt: new Date(),
        feedback: null,
        analysisJob: j,
      }));
      (prisma.findingOccurrence.findMany as any).mockResolvedValueOnce(occurrences);

      const summary = await aggregateRepositoryPatterns('repo-1', { recurringPrThreshold: 3 });

      expect(summary.distinctPatternsCount).toBe(1);
      expect(summary.recurringPatternsCount).toBe(1);
    });
  });

  describe('getRepositoryInsights', () => {
    it('throws error if repository not found', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce(null);

      await expect(getRepositoryInsights('repo-missing')).rejects.toThrow('Repository not found');
    });

    it('returns insights DTO with insufficientHistory when pattern count is 0', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce({
        id: 'repo-1',
        historicalIntelligenceEnabled: false,
      });
      (prisma.historicalPattern.findFirst as any).mockResolvedValueOnce({
        aggregatedAt: new Date(),
      });
      (prisma.historicalPattern.findMany as any).mockResolvedValueOnce([]);

      const dto = await getRepositoryInsights('repo-1');

      expect(dto.repositoryId).toBe('repo-1');
      expect(dto.insufficientHistory).toBe(true);
      expect(dto.patterns).toEqual([]);
      expect(dto.summary.distinctPatternsCount).toBe(0);
    });

    it('returns insights DTO with patterns and accurate metrics', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce({
        id: 'repo-1',
        historicalIntelligenceEnabled: true,
      });
      (prisma.historicalPattern.findFirst as any).mockResolvedValueOnce({
        aggregatedAt: new Date(),
      });

      const mockPatterns = [
        {
          id: 'pat-1',
          fingerprint: 'fp_v1_SECURITY:auth:1',
          algorithmVersion: 'fp_v1',
          category: 'SECURITY',
          source: 'SEMANTIC',
          summary: 'Hardcoded secret',
          occurrenceCount: 5,
          distinctPrCount: 3,
          acceptedCount: 3,
          rejectedCount: 1,
          unreviewedCount: 1,
          rejectionReasons: { FALSE_POSITIVE: 1 },
          representativePaths: ['src/auth.ts'],
          firstObservedAt: new Date('2026-01-01'),
          lastObservedAt: new Date('2026-02-01'),
          aggregatedAt: new Date(),
        },
      ];
      (prisma.historicalPattern.findMany as any).mockResolvedValueOnce(mockPatterns);

      const dto = await getRepositoryInsights('repo-1');

      expect(dto.historicalIntelligenceEnabled).toBe(true);
      expect(dto.insufficientHistory).toBe(false);
      expect(dto.summary.recurringPatternsCount).toBe(1);
      expect(dto.summary.falsePositiveTotal).toBe(1);
      expect(dto.patterns[0].isRecurring).toBe(true);
    });
  });
});
