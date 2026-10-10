/**
 * Pattern aggregation service — Phase 8 Historical Intelligence (Milestone 3)
 *
 * Rebuilds repository-scoped HistoricalPattern records from FindingOccurrence rows.
 *
 * Invariants:
 *  - Queue retries do not inflate occurrences (superseded snapshots excluded).
 *  - Multiple reviews of the same PR do not inflate distinct-PR support:
 *    distinctPrCount counts unique PR referenceIds only.
 *  - Multiple occurrences within a single PR do not count as separate PRs.
 *  - Aggregation is bounded (90-day window, max 200 jobs) and idempotent.
 *  - Only explicit FALSE_POSITIVE rejection reasons contribute to reported false-positive rate.
 */

import prisma from '../../config/prisma';
import type { FindingCategory, Prisma } from '@prisma/client';
import { normalizeCategory } from '../ai/finding-taxonomy';
import { FINGERPRINT_VERSION } from './fingerprint.service';
import { generateFingerprint, normalizePathScope } from './fingerprint.service';
import { HISTORY_DAYS, RECURRING_PR_THRESHOLD, lockHistoricalRepository } from './state';
import type { AiSuggestion } from '../ai/finding-taxonomy';

export interface AggregationOptions {
  windowDays?: number;
  maxJobs?: number;
  algorithmVersion?: string;
  recurringPrThreshold?: number;
}

export interface AggregationSummary {
  repositoryId: string;
  totalOccurrences: number;
  distinctPatternsCount: number;
  recurringPatternsCount: number;
  acceptedTotal: number;
  rejectedTotal: number;
  falsePositiveTotal: number;
  aggregatedAt: Date;
}

export interface RepositoryInsightsDto {
  repositoryId: string;
  historicalIntelligenceEnabled: boolean;
  freshness: Date;
  insufficientHistory: boolean;
  recurringPrThreshold: number;
  summary: {
    totalOccurrences: number;
    distinctPatternsCount: number;
    recurringPatternsCount: number;
    acceptedTotal: number;
    rejectedTotal: number;
    falsePositiveTotal: number;
    unreviewedTotal: number;
  };
  patterns: Array<{
    id: string;
    fingerprint: string;
    algorithmVersion: string;
    category: string;
    source: string;
    summary: string;
    occurrenceCount: number;
    distinctPrCount: number;
    acceptedCount: number;
    rejectedCount: number;
    unreviewedCount: number;
    rejectionReasons: Record<string, number>;
    representativePaths: string[];
    isRecurring: boolean;
    firstObservedAt: Date;
    lastObservedAt: Date;
    aggregatedAt: Date;
  }>;
}

const DEFAULT_WINDOW_DAYS = HISTORY_DAYS;
const DEFAULT_MAX_JOBS = 200;
const DEFAULT_RECURRING_THRESHOLD = RECURRING_PR_THRESHOLD;

/**
 * Rebuild aggregated patterns for a repository.
 * Safe, bounded, and idempotent.
 */
export async function aggregateRepositoryPatterns(
  repositoryId: string,
  options?: AggregationOptions,
): Promise<AggregationSummary> {
  return prisma.$transaction(async tx => {
    await lockHistoricalRepository(tx, repositoryId);
    return rebuildLockedPatterns(tx, repositoryId, options);
  }, { timeout: 30000 });
}

async function rebuildLockedPatterns(
  prisma: Prisma.TransactionClient, repositoryId: string, options?: AggregationOptions,
): Promise<AggregationSummary> {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repository?.isActive) throw new Error('Repository unavailable');
  const windowDays = options?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxJobs = options?.maxJobs ?? DEFAULT_MAX_JOBS;
  const algorithmVersion = options?.algorithmVersion ?? FINGERPRINT_VERSION;
  const recurringThreshold = options?.recurringPrThreshold ?? DEFAULT_RECURRING_THRESHOLD;

  const cutoffDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // 1. Fetch recent candidate completed jobs (bounded)
  const candidateJobs = await prisma.analysisJob.findMany({
    where: {
      repositoryId,
      status: 'COMPLETED',
      createdAt: { gte: cutoffDate },
    },
    select: {
      id: true,
      eventType: true,
      referenceId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: maxJobs,
  });

  const now = new Date();
  await prisma.repository.update({ where: { id: repositoryId }, data: {
    historicalAggregatedRevision: repository.historicalRevision, historicalAggregatedAt: now,
  } });

  if (candidateJobs.length === 0) {
    // Delete any stale aggregates for this repo since no completed reviews exist in window
    await prisma.historicalPattern.deleteMany({
      where: { repositoryId, algorithmVersion },
    });

    return {
      repositoryId,
      totalOccurrences: 0,
      distinctPatternsCount: 0,
      recurringPatternsCount: 0,
      acceptedTotal: 0,
      rejectedTotal: 0,
      falsePositiveTotal: 0,
      aggregatedAt: now,
    };
  }

  const jobIds = candidateJobs.map((j) => j.id);

  // 2. Fetch all non-superseded occurrences for candidate jobs
  const occurrences = await prisma.findingOccurrence.findMany({
    where: {
      repositoryId,
      analysisJobId: { in: jobIds },
      superseded: false,
    },
    include: {
      feedback: true,
      analysisJob: {
        select: {
          id: true,
          eventType: true,
          referenceId: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // 3. Group occurrences by fingerprint
  interface GroupedPatternData {
    fingerprint: string;
    category: FindingCategory;
    source: string;
    summary: string;
    occurrences: typeof occurrences;
    distinctPrs: Set<string>;
    paths: Set<string>;
    acceptedCount: number;
    rejectedCount: number;
    unreviewedCount: number;
    rejectionReasons: Record<string, number>;
    firstObservedAt: Date;
    lastObservedAt: Date;
  }

  const grouped = new Map<string, GroupedPatternData>();

  for (const occ of occurrences) {
    // v1 flattened path case; reconstruct scope from the original case-preserved path.
    let fingerprint = occ.fingerprint;
    if (fingerprint.startsWith('fp_v1_')) {
      if (occ.source !== 'LLM') {
        fingerprint = generateFingerprint({ filePath: occ.filePath, source: occ.source,
          agentType: occ.category, ruleKeys: Array.isArray(occ.ruleKeys) ? occ.ruleKeys : [],
        } as AiSuggestion);
      } else {
        const tokenHash = fingerprint.split(':').at(-1);
        if (!tokenHash || !/^[a-f0-9]{16}$/.test(tokenHash)) continue;
        fingerprint = `${FINGERPRINT_VERSION}_${occ.category}:${normalizePathScope(occ.filePath)}:${tokenHash}`;
      }
    }
    let group = grouped.get(fingerprint);
    if (!group) {
      const validCategory = (normalizeCategory(occ.category) ?? 'MAINTAINABILITY') as FindingCategory;
      group = {
        fingerprint,
        category: validCategory,
        source: occ.source,
        summary: occ.summary.slice(0, 300),
        occurrences: [],
        distinctPrs: new Set<string>(),
        paths: new Set<string>(),
        acceptedCount: 0,
        rejectedCount: 0,
        unreviewedCount: 0,
        rejectionReasons: {},
        firstObservedAt: occ.createdAt,
        lastObservedAt: occ.createdAt,
      };
      grouped.set(fingerprint, group);
    }

    group.occurrences.push(occ);
    if (occ.filePath) group.paths.add(occ.filePath);

    // Track distinct pull requests (ignoring retries and non-PR push jobs)
    if (occ.analysisJob?.eventType === 'PULL_REQUEST' && occ.analysisJob.referenceId) {
      group.distinctPrs.add(occ.analysisJob.referenceId);
    }

    // Feedback accounting
    const disposition = occ.feedback?.disposition ?? 'UNREVIEWED';
    if (disposition === 'ACCEPTED') {
      group.acceptedCount++;
    } else if (disposition === 'REJECTED') {
      group.rejectedCount++;
      const reason = occ.feedback?.rejectionReason;
      if (reason) {
        group.rejectionReasons[reason] = (group.rejectionReasons[reason] ?? 0) + 1;
      }
    } else {
      group.unreviewedCount++;
    }

    if (occ.createdAt < group.firstObservedAt) group.firstObservedAt = occ.createdAt;
    if (occ.createdAt > group.lastObservedAt) group.lastObservedAt = occ.createdAt;
  }

  // 4. Batch upsert into HistoricalPattern
  const currentFingerprints = Array.from(grouped.keys());

  let totalOccurrences = 0;
  let acceptedTotal = 0;
  let rejectedTotal = 0;
  let falsePositiveTotal = 0;
  let recurringPatternsCount = 0;

  for (const [fingerprint, data] of grouped.entries()) {
    const distinctPrCount = data.distinctPrs.size;
    const occurrenceCount = data.occurrences.length;
    const representativePaths = Array.from(data.paths).slice(0, 10);
    const fpCount = data.rejectionReasons['FALSE_POSITIVE'] ?? 0;
    const expiresAt = new Date(Math.min(...data.occurrences.map(occ =>
      Math.min(occ.createdAt.getTime(), occ.analysisJob.createdAt.getTime()))) + windowDays * 86400000);

    totalOccurrences += occurrenceCount;
    acceptedTotal += data.acceptedCount;
    rejectedTotal += data.rejectedCount;
    falsePositiveTotal += fpCount;
    if (distinctPrCount >= recurringThreshold) {
      recurringPatternsCount++;
    }

    await prisma.historicalPattern.upsert({
      where: {
        repositoryId_fingerprint_algorithmVersion: {
          repositoryId,
          fingerprint,
          algorithmVersion,
        },
      },
      update: {
        category: data.category,
        source: data.source,
        summary: data.summary,
        occurrenceCount,
        distinctPrCount,
        acceptedCount: data.acceptedCount,
        rejectedCount: data.rejectedCount,
        unreviewedCount: data.unreviewedCount,
        rejectionReasons: data.rejectionReasons as any,
        representativePaths: representativePaths as any,
        firstObservedAt: data.firstObservedAt,
        lastObservedAt: data.lastObservedAt,
        aggregatedAt: now,
        expiresAt,
      },
      create: {
        repositoryId,
        fingerprint,
        algorithmVersion,
        category: data.category,
        source: data.source,
        summary: data.summary,
        occurrenceCount,
        distinctPrCount,
        acceptedCount: data.acceptedCount,
        rejectedCount: data.rejectedCount,
        unreviewedCount: data.unreviewedCount,
        rejectionReasons: data.rejectionReasons as any,
        representativePaths: representativePaths as any,
        firstObservedAt: data.firstObservedAt,
        lastObservedAt: data.lastObservedAt,
        aggregatedAt: now,
        expiresAt,
      },
    });
  }

  // Remove any previously recorded patterns for this repo and algorithm version
  // that no longer have any occurrences in the sliding window.
  await prisma.historicalPattern.deleteMany({
    where: {
      repositoryId,
      algorithmVersion,
      fingerprint: { notIn: currentFingerprints },
    },
  });

  return {
    repositoryId,
    totalOccurrences,
    distinctPatternsCount: currentFingerprints.length,
    recurringPatternsCount,
    acceptedTotal,
    rejectedTotal,
    falsePositiveTotal,
    aggregatedAt: now,
  };
}

/**
 * Retrieve repository historical insights.
 * Automatically runs aggregation if patterns are absent or stale (> 1 hour old).
 */
export async function getRepositoryInsights(
  repositoryId: string,
  options?: { minDistinctPrs?: number; forceRefresh?: boolean },
): Promise<RepositoryInsightsDto> {
  const recurringThreshold = DEFAULT_RECURRING_THRESHOLD;
  const minPrs = options?.minDistinctPrs ?? 1;

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, historicalIntelligenceEnabled: true },
  });

  if (!repo) {
    throw new Error('Repository not found');
  }

  // Check freshness of existing patterns
  const latestPattern = await prisma.historicalPattern.findFirst({
    where: { repositoryId, algorithmVersion: FINGERPRINT_VERSION },
    orderBy: { aggregatedAt: 'desc' },
  });

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const needsRebuild =
    options?.forceRefresh ||
    !latestPattern ||
    latestPattern.aggregatedAt < oneHourAgo;

  if (needsRebuild) {
    await aggregateRepositoryPatterns(repositoryId);
  }

  // Fetch updated patterns
  const patterns = await prisma.historicalPattern.findMany({
    where: {
      repositoryId,
      algorithmVersion: FINGERPRINT_VERSION,
      distinctPrCount: { gte: minPrs },
      expiresAt: { gt: new Date() },
    },
    orderBy: [{ distinctPrCount: 'desc' }, { occurrenceCount: 'desc' }],
    take: 50,
  });

  let totalOccurrences = 0;
  let acceptedTotal = 0;
  let rejectedTotal = 0;
  let unreviewedTotal = 0;
  let falsePositiveTotal = 0;
  let recurringPatternsCount = 0;

  for (const p of patterns) {
    totalOccurrences += p.occurrenceCount;
    acceptedTotal += p.acceptedCount;
    rejectedTotal += p.rejectedCount;
    unreviewedTotal += p.unreviewedCount;
    const reasons = (p.rejectionReasons && typeof p.rejectionReasons === 'object')
      ? (p.rejectionReasons as Record<string, number>)
      : {};
    falsePositiveTotal += Number(reasons['FALSE_POSITIVE'] ?? 0);
    if (p.distinctPrCount >= recurringThreshold) {
      recurringPatternsCount++;
    }
  }

  const freshness = needsRebuild ? new Date() : latestPattern!.aggregatedAt;
  const insufficientHistory = patterns.length === 0 || recurringPatternsCount === 0;

  return {
    repositoryId: repo.id,
    historicalIntelligenceEnabled: repo.historicalIntelligenceEnabled,
    freshness,
    insufficientHistory,
    recurringPrThreshold: recurringThreshold,
    summary: {
      totalOccurrences,
      distinctPatternsCount: patterns.length,
      recurringPatternsCount,
      acceptedTotal,
      rejectedTotal,
      falsePositiveTotal,
      unreviewedTotal,
    },
    patterns: patterns.map((p) => {
      const reasons = (p.rejectionReasons && typeof p.rejectionReasons === 'object')
        ? (p.rejectionReasons as Record<string, number>)
        : {};
      const paths = Array.isArray(p.representativePaths)
        ? (p.representativePaths as string[])
        : [];

      return {
        id: p.id,
        fingerprint: p.fingerprint,
        algorithmVersion: p.algorithmVersion,
        category: p.category,
        source: p.source,
        summary: p.summary,
        occurrenceCount: p.occurrenceCount,
        distinctPrCount: p.distinctPrCount,
        acceptedCount: p.acceptedCount,
        rejectedCount: p.rejectedCount,
        unreviewedCount: p.unreviewedCount,
        rejectionReasons: reasons,
        representativePaths: paths,
        isRecurring: p.distinctPrCount >= recurringThreshold,
        firstObservedAt: p.firstObservedAt,
        lastObservedAt: p.lastObservedAt,
        aggregatedAt: p.aggregatedAt,
      };
    }),
  };
}
