/**
 * Unit tests — occurrence.service.ts (Phase 8)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../config/prisma';

// Mock Prisma before importing the service so the service picks up the mock.
vi.mock('../../config/prisma', () => ({
  default: {
    findingOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { recordJobFindings } from './occurrence.service';
import type { AiSuggestion } from '../ai/finding-taxonomy';

const mockPrisma = prisma as any;

const makeFinding = (overrides: Partial<AiSuggestion> = {}): AiSuggestion => ({
  filePath: 'src/controllers/user.controller.ts',
  lineNumber: 10,
  agentType: 'SECURITY',
  issue: 'SQL injection risk in query builder.',
  suggestion: 'Use parameterised queries.',
  priority: 'HIGH',
  source: 'LLM',
  ...overrides,
});

describe('recordJobFindings', () => {
  const JOB_ID = 'job-abc-123';
  const REPO_ID = 'repo-xyz-456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when findings array is empty', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, []);
    expect(mockPrisma.findingOccurrence.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.findingOccurrence.createMany).not.toHaveBeenCalled();
  });

  it('marks previous snapshots as superseded before inserting', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()]);

    expect(mockPrisma.findingOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ analysisJobId: JOB_ID, superseded: false }),
        data: { superseded: true },
      }),
    );
  });

  it('inserts one row per finding', async () => {
    const findings = [makeFinding(), makeFinding({ filePath: 'src/other.ts', lineNumber: 20 })];
    await recordJobFindings(JOB_ID, REPO_ID, findings);

    const call = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(call.data).toHaveLength(2);
    expect(call.skipDuplicates).toBe(true);
  });

  it('builds snapshotKeys as jobId:snapshotSeq:index', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding(), makeFinding()], 0);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(data[0].snapshotKey).toBe(`${JOB_ID}:0:0`);
    expect(data[1].snapshotKey).toBe(`${JOB_ID}:0:1`);
  });

  it('uses a non-zero snapshotSeq for retries', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()], 2);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(data[0].snapshotKey).toBe(`${JOB_ID}:2:0`);
  });

  it('sets superseded=false on new rows', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()]);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(data[0].superseded).toBe(false);
  });

  it('sets repositoryId correctly', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()]);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(data[0].repositoryId).toBe(REPO_ID);
    expect(data[0].analysisJobId).toBe(JOB_ID);
  });

  it('includes a non-empty fingerprint for each finding', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()]);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(typeof data[0].fingerprint).toBe('string');
    expect(data[0].fingerprint.length).toBeGreaterThan(0);
  });

  it('includes a non-empty summary for each finding', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()]);
    const { data } = mockPrisma.findingOccurrence.createMany.mock.calls[0][0];
    expect(typeof data[0].summary).toBe('string');
    expect(data[0].summary.length).toBeGreaterThan(0);
  });

  it('supersede-filter uses the current snapshotSeq prefix', async () => {
    await recordJobFindings(JOB_ID, REPO_ID, [makeFinding()], 3);
    const updateCall = mockPrisma.findingOccurrence.updateMany.mock.calls[0][0];
    expect(updateCall.where.NOT).toEqual(
      expect.objectContaining({ snapshotKey: { startsWith: `${JOB_ID}:3:` } }),
    );
  });
});
