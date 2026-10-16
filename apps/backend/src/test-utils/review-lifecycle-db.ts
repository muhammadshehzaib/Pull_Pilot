import { vi } from 'vitest';

/** Serialized transactions + rollback for service-level lifecycle tests. This
 * models the locking contract; it does not substitute for PostgreSQL tests. */
export const lifecycleState: any = { jobs: [], repos: [], ledgers: [], installations: [] };
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('lt' in value) return row[key] < value.lt;
      if (key.endsWith('_billingMonth')) return matches(row, value);
      return matches(row[key], value);
    }
    return row?.[key] === value;
  });
}
function apply(row: any, data: any) {
  for (const [key, value] of Object.entries(data) as [string, any][]) {
    row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment
      : value && typeof value === 'object' && 'decrement' in value ? row[key] - value.decrement : clone(value);
  }
  row.updatedAt = data.updatedAt ?? new Date();
  return clone(row);
}
const hydrated = (row: any) => row && ({ ...row, repository: lifecycleState.repos.find((r: any) => r.id === row.repositoryId) });
let transactionTail = Promise.resolve();
export const lifecycleDb: any = {
  $queryRaw: vi.fn(async () => [{ id: 'repo' }]),
  $transaction: vi.fn(async (fn: any) => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = clone(lifecycleState);
    try { return await fn(lifecycleDb); }
    catch (error) { Object.assign(lifecycleState, snapshot); throw error; }
    finally { release(); }
  }),
  analysisJob: {
    findUnique: vi.fn(async ({ where }: any) => clone(hydrated(lifecycleState.jobs.find((row: any) => matches(row, where))))),
    findMany: vi.fn(async ({ where, take }: any) => clone(lifecycleState.jobs.filter((row: any) => matches(hydrated(row), where))
      .sort((a: any, b: any) => a.id.localeCompare(b.id)).slice(0, take).map(hydrated))),
    update: vi.fn(async ({ where, data }: any) => {
      const row = lifecycleState.jobs.find((row: any) => matches(row, where));
      if (!row) throw new Error('Review missing');
      return apply(row, data);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = lifecycleState.jobs.filter((row: any) => matches(hydrated(row), where));
      rows.forEach((row: any) => apply(row, data)); return { count: rows.length };
    }),
  },
  usageLedger: {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      let row = lifecycleState.ledgers.find((row: any) => matches(row, where));
      if (!row) { row = { id: `ledger-${lifecycleState.ledgers.length}`, ...create }; lifecycleState.ledgers.push(row); }
      return apply(row, update);
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const row = lifecycleState.ledgers.find((row: any) => matches(row, where));
      if (!row) throw new Error('Ledger missing'); return clone(row);
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = lifecycleState.ledgers.find((row: any) => matches(row, where));
      if (!row) throw new Error('Ledger missing'); return apply(row, data);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = lifecycleState.ledgers.filter((row: any) => matches(row, where));
      rows.forEach((row: any) => apply(row, data)); return { count: rows.length };
    }),
  },
  installation: { findUnique: vi.fn(async ({ where }: any) => clone(lifecycleState.installations.find((row: any) => matches(row, where)) ?? null)) },
  subscription: { findFirst: vi.fn(async () => null) },
};

export function resetLifecycleDb() {
  lifecycleState.jobs = []; lifecycleState.ledgers = []; lifecycleState.installations = [];
  lifecycleState.repos = [{ id: 'repo', userId: 'user', installationId: 'install', isActive: true }];
}
