import type { CommentDelivery } from '@prisma/client';

export const DELIVERY_TERMINAL_STATES = ['DELIVERED', 'REJECTED', 'OMITTED'] as const;
export type DeliveryReport = ReturnType<typeof commentDeliveryReport>;

export function needsLocationSummary(rows: Pick<CommentDelivery, 'kind' | 'reason'>[]) {
  return rows.some(row => row.kind === 'INLINE' && row.reason === 'location-unverified') && !rows.some(row => row.kind === 'SUMMARY');
}

export function commentDeliveryReport(rows: Pick<CommentDelivery, 'kind' | 'state' | 'reason' | 'githubUrl'>[]) {
  const inline = rows.filter(r => r.kind === 'INLINE');
  const summary = rows.find(r => r.kind === 'SUMMARY');
  const count = (state: string) => inline.filter(r => r.state === state).length;
  return {
    version: 1 as const, expected: inline.length, delivered: count('DELIVERED'),
    rejected: count('REJECTED'), omitted: count('OMITTED'),
    pending: count('READY') + count('WAITING') + count('SENDING'), unconfirmed: count('UNKNOWN'),
    summary: summary?.state ?? 'DISABLED',
    repositoryDisconnected: rows.some(r => r.reason === 'repository-disconnected'),
    reasons: [...new Set(rows.map(r => r.reason).filter((s): s is string => !!s))].slice(0, 10),
    links: rows.filter(r => r.state === 'DELIVERED' && r.githubUrl && /^https:\/\/github\.com\//.test(r.githubUrl))
      .slice(0, 100).map(r => r.githubUrl!),
  };
}
