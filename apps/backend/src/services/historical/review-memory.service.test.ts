import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../config/prisma';

vi.mock('../../config/prisma', () => ({
  default: {
    repository: {
      findUnique: vi.fn(),
    },
    historicalPattern: {
      findMany: vi.fn(),
    },
  },
}));

import {
  retrieveHistoricalMemory,
  formatHistoricalMemoryForPrompt,
  HISTORICAL_MEMORY_HEADER,
} from './review-memory.service';

describe('review-memory.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('retrieveHistoricalMemory', () => {
    it('returns null if repository has historical intelligence disabled', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce({
        historicalIntelligenceEnabled: false,
      });

      const res = await retrieveHistoricalMemory('repo-1', ['src/auth.ts']);
      expect(res).toBeNull();
      expect(prisma.historicalPattern.findMany).not.toHaveBeenCalled();
    });

    it('returns null if repository is not found', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce(null);

      const res = await retrieveHistoricalMemory('repo-missing');
      expect(res).toBeNull();
    });

    it('returns null if no historical patterns exist', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce({
        historicalIntelligenceEnabled: true,
      });
      (prisma.historicalPattern.findMany as any).mockResolvedValueOnce([]);

      const res = await retrieveHistoricalMemory('repo-1');
      expect(res).toBeNull();
    });

    it('retrieves and prioritizes patterns matching changed files', async () => {
      (prisma.repository.findUnique as any).mockResolvedValueOnce({
        historicalIntelligenceEnabled: true,
      });

      const patterns = [
        {
          id: 'pat-1',
          fingerprint: 'fp_v1_BUG:null-check:1',
          category: 'BUG',
          summary: 'Missing null check on profile',
          distinctPrCount: 2,
          occurrenceCount: 2,
          acceptedCount: 2,
          rejectedCount: 0,
          representativePaths: ['src/profile.ts'],
        },
        {
          id: 'pat-2',
          fingerprint: 'fp_v1_SECURITY:jwt:1',
          category: 'SECURITY',
          summary: 'Insecure JWT verification',
          distinctPrCount: 2,
          occurrenceCount: 2,
          acceptedCount: 2,
          rejectedCount: 0,
          representativePaths: ['src/auth/jwt.ts'],
        },
      ];
      (prisma.historicalPattern.findMany as any).mockResolvedValueOnce(patterns);

      // Changed files include jwt.ts -> pat-2 should be prioritized first
      const res = await retrieveHistoricalMemory('repo-1', ['src/auth/jwt.ts']);

      expect(res).not.toBeNull();
      expect(res?.patterns).toHaveLength(2);
      expect(res?.patterns[0].patternId).toBe('pat-2');
      expect(res?.suppliedPatternIds).toEqual(['pat-2', 'pat-1']);
      expect(res?.serializedContext).toContain('CRITICAL SAFETY RULES:');
      expect(res?.serializedContext).toContain('Insecure JWT verification');
    });

    it('catches database errors gracefully and returns null without throwing', async () => {
      (prisma.repository.findUnique as any).mockRejectedValueOnce(new Error('DB connection failed'));

      const res = await retrieveHistoricalMemory('repo-1');
      expect(res).toBeNull();
    });
  });

  describe('formatHistoricalMemoryForPrompt', () => {
    it('returns empty string if patterns array is empty', () => {
      const res = formatHistoricalMemoryForPrompt([]);
      expect(res.serializedContext).toBe('');
      expect(res.truncated).toBe(false);
    });

    it('includes safety rules and formatted pattern blocks', () => {
      const patterns = [
        {
          patternId: 'p-1',
          fingerprint: 'fp-1',
          category: 'SECURITY',
          summary: 'Hardcoded credentials',
          distinctPrCount: 4,
          acceptedCount: 3,
          rejectedCount: 0,
          relevantPaths: ['src/config.ts'],
        },
      ];

      const res = formatHistoricalMemoryForPrompt(patterns, 4000);

      expect(res.serializedContext).toContain(HISTORICAL_MEMORY_HEADER.trim());
      expect(res.serializedContext).toContain('Hardcoded credentials');
      expect(res.serializedContext).toContain('Category: SECURITY');
      expect(res.serializedContext).toContain('Across 4 PR(s)');
      expect(res.serializedContext).toContain('=== END HISTORICAL PATTERNS ===');
      expect(res.truncated).toBe(false);
    });

    it('marks truncated when context exceeds maxChars budget', () => {
      const patterns = Array.from({ length: 5 }, (_, i) => ({
        patternId: `p-${i}`,
        fingerprint: `fp-${i}`,
        category: 'BUG',
        summary: `Long summary description for pattern ${i} that consumes considerable character budget`,
        distinctPrCount: 3,
        acceptedCount: 2,
        rejectedCount: 1,
        relevantPaths: [`src/file-${i}.ts`],
      }));

      const res = formatHistoricalMemoryForPrompt(patterns, 600);
      expect(res.truncated).toBe(true);
    });
  });
});
