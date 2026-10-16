import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuotaService, FREE_TIER_PRIVATE_LIMIT } from './quota.service';
import prisma from '../config/prisma';

vi.mock('../config/prisma', () => ({
  default: {
    installation: {
      findUnique: vi.fn(),
    },
    usageLedger: {
      upsert: vi.fn(),
      aggregate: vi.fn(),
    },
    subscription: { findFirst: vi.fn() },
  },
}));

describe('QuotaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.installation.findUnique).mockResolvedValue({ userId: 'user' } as any);
    vi.mocked(prisma.usageLedger.aggregate).mockResolvedValue({ _sum: { publicReviewsCount: 0, privateReviewsCount: 0 } } as any);
  });

  describe('getCurrentBillingMonth', () => {
    it('formats month in YYYY-MM UTC format', () => {
      const date1 = new Date('2026-09-15T10:00:00Z');
      expect(QuotaService.getCurrentBillingMonth(date1)).toBe('2026-09');

      const date2 = new Date('2026-01-01T00:00:00Z');
      expect(QuotaService.getCurrentBillingMonth(date2)).toBe('2026-01');

      const date3 = new Date('2026-12-31T23:59:59Z');
      expect(QuotaService.getCurrentBillingMonth(date3)).toBe('2026-12');
    });
  });

  describe('checkQuota', () => {
    it('refuses reviews when no usage owner is known', async () => {
      const result = await QuotaService.checkQuota(null, true);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('owner');
    });

    it('allows unlimited reviews on public repositories regardless of count', async () => {
      (prisma.usageLedger.aggregate as any).mockResolvedValueOnce({ _sum: {
        publicReviewsCount: 150,
        privateReviewsCount: 0,
      } });

      const result = await QuotaService.checkQuota('inst-123', false);
      expect(result.allowed).toBe(true);
      expect(result.usage.isPrivate).toBe(false);
      expect(result.usage.limit).toBeNull();
    });

    it('allows private reviews when within the 50 reviews/month free quota', async () => {
      (prisma.installation.findUnique as any).mockResolvedValueOnce({
        id: 'inst-123', userId: 'user',
        plan: 'FREE',
      });

      (prisma.usageLedger.aggregate as any).mockResolvedValueOnce({ _sum: {
        publicReviewsCount: 10,
        privateReviewsCount: 42,
      } });

      const result = await QuotaService.checkQuota('inst-123', true);
      expect(result.allowed).toBe(true);
      expect(result.usage.current).toBe(42);
      expect(result.usage.limit).toBe(FREE_TIER_PRIVATE_LIMIT);
    });

    it('rejects private reviews when monthly free quota is reached (>= 50)', async () => {
      (prisma.installation.findUnique as any).mockResolvedValueOnce({
        id: 'inst-123', userId: 'user',
        plan: 'FREE',
      });

      (prisma.usageLedger.aggregate as any).mockResolvedValueOnce({ _sum: {
        publicReviewsCount: 5,
        privateReviewsCount: 50,
      } });

      const result = await QuotaService.checkQuota('inst-123', true);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Monthly free tier quota exceeded');
      expect(result.usage.current).toBe(50);
      expect(result.usage.limit).toBe(50);
    });

    it('allows unlimited private reviews for INDIE and TEAM plans', async () => {
      (prisma.subscription.findFirst as any).mockResolvedValueOnce({ plan: 'INDIE', status: 'active' });

      (prisma.usageLedger.aggregate as any).mockResolvedValueOnce({ _sum: {
        publicReviewsCount: 20,
        privateReviewsCount: 250,
      } });

      const result = await QuotaService.checkQuota('inst-paid', true);
      expect(result.allowed).toBe(true);
      expect(result.usage.limit).toBeNull();
    });
  });

  describe('getQuotaExceededComment', () => {
    it('returns formatted markdown notification with upgrade info', () => {
      const comment = QuotaService.getQuotaExceededComment(50, 50);
      expect(comment).toContain('Free Tier Monthly Limit Reached');
      expect(comment).toContain('50 of 50');
      expect(comment).toContain('Indie Plan');
    });
  });
});
