import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../config/prisma';

vi.mock('../../config/prisma', () => {
  const mockTx = {
    findingFeedback: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    findingFeedbackEvent: {
      create: vi.fn(),
    },
  };

  return {
    default: {
      findingFeedback: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      findingFeedbackEvent: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
      _mockTx: mockTx,
    },
  };
});

import {
  updateFeedback,
  getFeedbackForOccurrences,
  getFeedbackEvents,
  FeedbackConflictError,
} from './feedback.service';

const mockTx = (prisma as any)._mockTx;

describe('feedback.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('updateFeedback', () => {
    it('creates initial feedback with revision 0 and audit event', async () => {
      mockTx.findingFeedback.findUnique.mockResolvedValueOnce(null);
      const mockCreated = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'ACCEPTED',
        rejectionReason: null,
        note: 'looks good',
        revision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTx.findingFeedback.create.mockResolvedValueOnce(mockCreated);
      mockTx.findingFeedbackEvent.create.mockResolvedValueOnce({ id: 'evt-1' });

      const result = await updateFeedback({
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'ACCEPTED',
        note: 'looks good',
      });

      expect(result).toMatchObject({
        id: 'fb-1',
        occurrenceId: 'occ-1',
        disposition: 'ACCEPTED',
        rejectionReason: null,
        note: 'looks good',
        revision: 0,
      });

      expect(mockTx.findingFeedback.create).toHaveBeenCalledWith({
        data: {
          occurrenceId: 'occ-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          rejectionReason: null,
          note: 'looks good',
          revision: 0,
        },
      });

      expect(mockTx.findingFeedbackEvent.create).toHaveBeenCalledWith({
        data: {
          feedbackId: 'fb-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          rejectionReason: null,
          revision: 0,
        },
      });
    });

    it('requires rejectionReason when disposition is REJECTED', async () => {
      await expect(
        updateFeedback({
          occurrenceId: 'occ-1',
          actorId: 'user-1',
          disposition: 'REJECTED',
        }),
      ).rejects.toThrow('rejectionReason is required when disposition is REJECTED.');
    });

    it('rejects notes longer than 1000 characters', async () => {
      const longNote = 'a'.repeat(1001);
      await expect(
        updateFeedback({
          occurrenceId: 'occ-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          note: longNote,
        }),
      ).rejects.toThrow('Note exceeds maximum length of 1000 characters.');
    });

    it('updates existing feedback and increments revision from 0 to 1 with an event', async () => {
      const existing = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'UNREVIEWED',
        rejectionReason: null,
        note: null,
        revision: 0,
        updatedAt: new Date('2026-01-01'),
      };
      mockTx.findingFeedback.findUnique.mockResolvedValueOnce(existing);

      const updated = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        actorId: 'user-2',
        disposition: 'REJECTED',
        rejectionReason: 'FALSE_POSITIVE',
        note: 'not a bug',
        revision: 1,
        updatedAt: new Date('2026-01-02'),
      };
      mockTx.findingFeedback.update.mockResolvedValueOnce(updated);
      mockTx.findingFeedbackEvent.create.mockResolvedValueOnce({ id: 'evt-2' });

      const res = await updateFeedback({
        occurrenceId: 'occ-1',
        actorId: 'user-2',
        disposition: 'REJECTED',
        rejectionReason: 'FALSE_POSITIVE',
        note: 'not a bug',
        expectedRevision: 0,
      });

      expect(res.revision).toBe(1);
      expect(res.disposition).toBe('REJECTED');
      expect(res.rejectionReason).toBe('FALSE_POSITIVE');
      expect(mockTx.findingFeedback.update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          actorId: 'user-2',
          disposition: 'REJECTED',
          rejectionReason: 'FALSE_POSITIVE',
          note: 'not a bug',
          revision: 1,
        },
      });
      expect(mockTx.findingFeedbackEvent.create).toHaveBeenCalledWith({
        data: {
          feedbackId: 'fb-1',
          actorId: 'user-2',
          disposition: 'REJECTED',
          rejectionReason: 'FALSE_POSITIVE',
          revision: 1,
        },
      });
    });

    it('throws FeedbackConflictError if expectedRevision mismatches current DB revision', async () => {
      const existing = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        revision: 3,
      };
      mockTx.findingFeedback.findUnique.mockResolvedValueOnce(existing);

      await expect(
        updateFeedback({
          occurrenceId: 'occ-1',
          actorId: 'user-1',
          disposition: 'ACCEPTED',
          expectedRevision: 2,
        }),
      ).rejects.toThrow(FeedbackConflictError);
    });

    it('returns existing feedback without incrementing revision if values are identical (idempotency)', async () => {
      const existing = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        disposition: 'ACCEPTED',
        rejectionReason: null,
        note: 'same note',
        revision: 2,
        updatedAt: new Date(),
      };
      mockTx.findingFeedback.findUnique.mockResolvedValueOnce(existing);

      const res = await updateFeedback({
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'ACCEPTED',
        note: 'same note',
        expectedRevision: 2,
      });

      expect(res.revision).toBe(2);
      expect(mockTx.findingFeedback.update).not.toHaveBeenCalled();
      expect(mockTx.findingFeedbackEvent.create).not.toHaveBeenCalled();
    });

    it('supports resetting disposition to UNREVIEWED', async () => {
      const existing = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        disposition: 'REJECTED',
        rejectionReason: 'FALSE_POSITIVE',
        note: 'was rejected',
        revision: 1,
        updatedAt: new Date(),
      };
      mockTx.findingFeedback.findUnique.mockResolvedValueOnce(existing);

      const resetResult = {
        id: 'fb-1',
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'UNREVIEWED',
        rejectionReason: null,
        note: null,
        revision: 2,
        updatedAt: new Date(),
      };
      mockTx.findingFeedback.update.mockResolvedValueOnce(resetResult);
      mockTx.findingFeedbackEvent.create.mockResolvedValueOnce({ id: 'evt-reset' });

      const res = await updateFeedback({
        occurrenceId: 'occ-1',
        actorId: 'user-1',
        disposition: 'UNREVIEWED',
        expectedRevision: 1,
      });

      expect(res.disposition).toBe('UNREVIEWED');
      expect(res.rejectionReason).toBeNull();
      expect(res.revision).toBe(2);
    });
  });

  describe('getFeedbackForOccurrences', () => {
    it('returns empty map for empty array', async () => {
      const map = await getFeedbackForOccurrences([]);
      expect(map.size).toBe(0);
      expect(prisma.findingFeedback.findMany).not.toHaveBeenCalled();
    });

    it('maps findings by occurrenceId', async () => {
      const rows = [
        {
          id: 'fb-1',
          occurrenceId: 'occ-1',
          disposition: 'ACCEPTED' as const,
          rejectionReason: null,
          note: 'ok',
          revision: 0,
          updatedAt: new Date(),
        },
      ];
      (prisma.findingFeedback.findMany as any).mockResolvedValueOnce(rows);

      const map = await getFeedbackForOccurrences(['occ-1']);
      expect(map.size).toBe(1);
      expect(map.get('occ-1')?.disposition).toBe('ACCEPTED');
    });
  });

  describe('getFeedbackEvents', () => {
    it('returns empty array if no feedback row exists', async () => {
      (prisma.findingFeedback.findUnique as any).mockResolvedValueOnce(null);
      const events = await getFeedbackEvents('occ-nonexistent');
      expect(events).toEqual([]);
    });

    it('returns ordered feedback audit events', async () => {
      const mockEvents = [
        {
          id: 'evt-2',
          feedbackId: 'fb-1',
          actorId: 'u-2',
          disposition: 'ACCEPTED',
          rejectionReason: null,
          revision: 1,
          createdAt: new Date('2026-02-01'),
        },
        {
          id: 'evt-1',
          feedbackId: 'fb-1',
          actorId: 'u-1',
          disposition: 'UNREVIEWED',
          rejectionReason: null,
          revision: 0,
          createdAt: new Date('2026-01-01'),
        },
      ];
      (prisma.findingFeedback.findUnique as any).mockResolvedValueOnce({
        id: 'fb-1',
        events: mockEvents,
      });

      const events = await getFeedbackEvents('occ-1');
      expect(events).toHaveLength(2);
      expect(events[0].revision).toBe(1);
      expect(events[1].revision).toBe(0);
    });
  });
});
