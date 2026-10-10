import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !/^--(apply|after=[a-zA-Z0-9-]{1,64}|batch-size=\d{1,3})$/.test(a)))
    throw new Error('Usage: backfill-analytics [--apply] [--after=CURSOR] [--batch-size=1..100]');
  const { backfillAnalyticsBatch } = await import('../services/analytics/backfill');
  const { default: prisma } = await import('../config/prisma');
  try { console.log(JSON.stringify(await backfillAnalyticsBatch({ apply: args.includes('--apply'),
    after: args.find(a => a.startsWith('--after='))?.slice(8),
    batchSize: Number(args.find(a => a.startsWith('--batch-size='))?.slice(13) ?? 100) }))); }
  finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error('Analytics backfill failed. Check arguments and database migration; no content logged.'); process.exitCode = 1; });
