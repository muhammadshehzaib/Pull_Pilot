import type { AnalysisJob, Prisma } from '@prisma/client';

/** Caller holds the job row lock; marker and decrement commit or roll back together. */
export async function refundReviewQuota(tx: Prisma.TransactionClient, job: Pick<AnalysisJob,
  'id' | 'quotaLedgerId' | 'quotaIsPrivate' | 'quotaRefundedAt'>) {
  if (!job.quotaLedgerId || job.quotaIsPrivate === null || job.quotaIsPrivate === undefined || job.quotaRefundedAt) return;
  const claimed = await tx.analysisJob.updateMany({
    where: { id: job.id, quotaLedgerId: job.quotaLedgerId, quotaRefundedAt: null },
    data: { quotaRefundedAt: new Date() },
  });
  if (!claimed.count) return;
  const field = job.quotaIsPrivate ? 'privateReviewsCount' : 'publicReviewsCount';
  await tx.usageLedger.updateMany({
    where: { id: job.quotaLedgerId, [field]: { gt: 0 } },
    data: { [field]: { decrement: 1 } },
  });
}
