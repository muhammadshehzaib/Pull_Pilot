import prisma from '../config/prisma';
import type { Prisma } from '@prisma/client';

export const ENTITLING_STATUSES = ['active', 'past_due', 'trialing'];

export class EntitlementService {
  static async getSubscription(userId: string, tx: Prisma.TransactionClient = prisma) {
    return tx.subscription.findFirst({
      where: { userId, status: { in: ENTITLING_STATUSES }, plan: { in: ['INDIE', 'TEAM'] } },
      // PlanTier is declared FREE, INDIE, TEAM in PostgreSQL, so descending
      // order gives the highest paid tier regardless of subscription recency.
      orderBy: [{ plan: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    });
  }
}
