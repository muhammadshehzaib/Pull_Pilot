import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../config/prisma';
import { recordJobFindings, findingIdentity } from './occurrence.service';
import type { AiSuggestion } from '../ai/finding-taxonomy';

vi.mock('../../config/prisma', () => {
  const db: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'repo' }]),
    repository: { findUnique: vi.fn(), update: vi.fn() },
    analysisJob: { findFirst: vi.fn(), update: vi.fn() },
    findingOccurrence: { updateMany: vi.fn(), createMany: vi.fn() },
    historicalPattern: { deleteMany: vi.fn() },
    reviewAnalyticsFact: { create: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: any) => fn(db));
  return { default: db };
});
const db = prisma as any;
const finding: AiSuggestion = { filePath: 'src/a.ts', lineNumber: 10, agentType: 'BUG', priority: 'HIGH', issue: 'Null dereference', suggestion: 'Guard null' };
let job: any;
let rows: any[];
beforeEach(() => {
  vi.clearAllMocks();
  job = { id: 'job', repositoryId: 'repo', createdAt: new Date(), status: 'COMPLETED', findingSnapshot: 0, findingSnapshotHash: null, results: [finding] };
  rows = [];
  db.repository.findUnique.mockResolvedValue({ isActive: true });
  db.analysisJob.findFirst.mockImplementation(async () => ({ ...job }));
  db.analysisJob.update.mockImplementation(async ({ data }: any) => Object.assign(job, data));
  db.findingOccurrence.updateMany.mockImplementation(async () => { rows.forEach(row => row.superseded = true); });
  db.findingOccurrence.createMany.mockImplementation(async ({ data }: any) => { rows.push(...data.map((row: any, i: number) => ({ ...row, id: `id-${rows.length + i}`, superseded: false }))); });
});
describe('durable finding artifacts', () => {
  it('records exact keys independently from cross-review fingerprints', async () => {
    await recordJobFindings('job', 'repo', [finding]);
    expect(rows[0]).toMatchObject({ findingKey: findingIdentity(finding), snapshotKey: `job:1:${findingIdentity(finding)}` });
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.repository.update).toHaveBeenCalledWith(expect.objectContaining({ data: { historicalRevision: { increment: 1 } } }));
  });
  it('same artifact retry preserves identities and does not invalidate twice', async () => {
    await recordJobFindings('job', 'repo', [finding]);
    await recordJobFindings('job', 'repo', [finding]);
    expect(rows).toHaveLength(1);
    expect(job.findingSnapshot).toBe(1);
    expect(db.historicalPattern.deleteMany).toHaveBeenCalledTimes(1);
  });
  it('regenerated artifacts supersede old IDs instead of rebinding feedback', async () => {
    await recordJobFindings('job', 'repo', [finding]);
    const changed = { ...finding, issue: 'A different defect' };
    await recordJobFindings('job', 'repo', [changed], { suggestions: [changed] });
    expect(rows[0].superseded).toBe(true);
    expect(rows[1].snapshotKey).toContain('job:2:');
    expect(rows[1].findingKey).not.toBe(rows[0].findingKey);
    expect(job.results.suggestions).toEqual([changed]);
  });
  it('empty replacement supersedes findings and still completes the review', async () => {
    await recordJobFindings('job', 'repo', [finding]);
    await recordJobFindings('job', 'repo', [], { suggestions: [] });
    expect(rows.every(row => row.superseded)).toBe(true);
    expect(job.findingSnapshot).toBe(2);
    expect(job.results).toEqual({ suggestions: [] });
  });
  it('reordering findings preserves their IDs', async () => {
    const other = { ...finding, filePath: 'src/b.ts' };
    await recordJobFindings('job', 'repo', [finding, other], { suggestions: [finding, other] });
    await recordJobFindings('job', 'repo', [other, finding], { suggestions: [other, finding] });
    expect(rows).toHaveLength(2);
    expect(job.findingSnapshot).toBe(1);
  });
  it('legacy backfill rejects changed results, non-completed jobs and expired history', async () => {
    await expect(recordJobFindings('job', 'repo', [{ ...finding, issue: 'stale' }])).rejects.toThrow('changed');
    job.status = 'RUNNING';
    await expect(recordJobFindings('job', 'repo', [finding])).rejects.toThrow('changed');
    job.status = 'COMPLETED'; job.createdAt = new Date(0);
    await expect(recordJobFindings('job', 'repo', [finding])).rejects.toThrow('expired');
    expect(rows).toHaveLength(0);
  });
  it('supports modern and legacy result shapes without rewriting legacy JSON', async () => {
    job.results = { suggestions: [finding] };
    await recordJobFindings('job', 'repo', [finding]);
    expect(db.analysisJob.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ results: expect.anything() }) }));
  });
  it('inactive or mismatched repositories cannot acquire new feedback identities', async () => {
    db.repository.findUnique.mockResolvedValue({ isActive: false });
    await expect(recordJobFindings('job', 'repo', [finding])).rejects.toThrow('unavailable');
  });
});
