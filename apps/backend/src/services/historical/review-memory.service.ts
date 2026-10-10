/**
 * Review memory service — Phase 8 Historical Intelligence (Milestone 4)
 *
 * Retrieves opt-in, bounded historical pattern context for future reviews
 * and formats it safely for AI model prompts.
 *
 * Safety boundaries:
 *  - Opt-in only: gated by repository.historicalIntelligenceEnabled.
 *  - Repository scoped: never leaks patterns across repositories or users.
 *  - Chronological barrier: uses only patterns available before current review.
 *  - Untrusted text: feedback notes are NEVER injected into prompts.
 *  - Bounded size: maximum 5 patterns, maximum 4,000 serialized characters.
 *  - Background guidance only: historical context is NEVER evidence that a current
 *    defect exists; findings must be anchored directly to changed lines.
 *  - Security protection: historical feedback never suppresses security probes
 *    or reduces risk severity.
 *  - Graceful degradation: retrieval failure never aborts an otherwise valid review.
 */

import prisma from '../../config/prisma';
import { FINGERPRINT_VERSION } from './fingerprint.service';

export interface HistoricalPatternMemory {
  patternId: string;
  fingerprint: string;
  category: string;
  summary: string;
  distinctPrCount: number;
  acceptedCount: number;
  rejectedCount: number;
  relevantPaths: string[];
}

export interface HistoricalReviewContext {
  version: 1;
  patterns: HistoricalPatternMemory[];
  truncated: boolean;
  suppliedPatternIds: string[];
  serializedContext: string;
}

const MAX_PATTERNS = 5;
const MAX_SERIALIZED_CHARS = 4000;

export const HISTORICAL_MEMORY_HEADER = `
=== REPOSITORY HISTORICAL PATTERNS (OPT-IN REVIEW MEMORY) ===
The following recurring patterns were previously observed across distinct pull requests in this repository.
Use this context solely as background guidance to inform what potential defects to look for.

CRITICAL SAFETY RULES:
1. Historical patterns are BACKGROUND GUIDANCE ONLY, NOT evidence that a defect exists in the current changes.
2. Every finding you report MUST have independent, verifiable proof directly on a changed line in this diff.
3. Do NOT invent findings simply because similar issues occurred in past pull requests.
4. Do NOT suppress security findings or reduce severity solely because past similar issues were dismissed.
5. If the current changes do not exhibit the defect, ignore the historical pattern.
`;

export const HISTORICAL_MEMORY_FOOTER = `
=== END HISTORICAL PATTERNS ===
`;

/**
 * Retrieve opt-in bounded historical review memory for a repository.
 * Returns null if historical intelligence is disabled or no patterns exist.
 */
export async function retrieveHistoricalMemory(
  repositoryId: string,
  changedFilePaths: string[] = [],
  beforeDate?: Date,
): Promise<HistoricalReviewContext | null> {
  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { historicalIntelligenceEnabled: true },
    });

    if (!repo?.historicalIntelligenceEnabled) {
      return null;
    }

    const whereClause: any = {
      repositoryId,
      algorithmVersion: FINGERPRINT_VERSION,
    };

    if (beforeDate) {
      whereClause.lastObservedAt = { lt: beforeDate };
    }

    const candidates = await prisma.historicalPattern.findMany({
      where: whereClause,
      orderBy: [{ distinctPrCount: 'desc' }, { occurrenceCount: 'desc' }],
      take: 20,
    });

    if (candidates.length === 0) {
      return null;
    }

    // Score and rank candidates by relevance to changed file paths
    const normalizedChanged = changedFilePaths.map((p) => p.toLowerCase().replace(/\\/g, '/'));

    const scored = candidates.map((p) => {
      const repPaths = Array.isArray(p.representativePaths)
        ? (p.representativePaths as string[])
        : [];

      let relevanceScore = p.distinctPrCount * 2 + p.acceptedCount;

      // Bonus if pattern affected a file currently being changed
      const matchesPath = repPaths.some((rp) => {
        const lowerRp = rp.toLowerCase().replace(/\\/g, '/');
        return normalizedChanged.some((cp) => cp.includes(lowerRp) || lowerRp.includes(cp));
      });

      if (matchesPath) {
        relevanceScore += 10;
      }

      return { pattern: p, repPaths, relevanceScore };
    });

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    const selected = scored.slice(0, MAX_PATTERNS);

    const patternsMemory: HistoricalPatternMemory[] = selected.map(({ pattern, repPaths }) => ({
      patternId: pattern.id,
      fingerprint: pattern.fingerprint,
      category: pattern.category,
      summary: pattern.summary,
      distinctPrCount: pattern.distinctPrCount,
      acceptedCount: pattern.acceptedCount,
      rejectedCount: pattern.rejectedCount,
      relevantPaths: repPaths,
    }));

    const suppliedPatternIds = patternsMemory.map((p) => p.patternId);

    // Build bounded serialized prompt
    const { serializedContext, truncated } = formatHistoricalMemoryForPrompt(
      patternsMemory,
      MAX_SERIALIZED_CHARS,
    );

    return {
      version: 1,
      patterns: patternsMemory,
      truncated,
      suppliedPatternIds,
      serializedContext,
    };
  } catch (err) {
    console.warn(
      `⚠️ [Phase8] Failed to retrieve historical memory for repo ${repositoryId}:`,
      err,
    );
    return null;
  }
}

/**
 * Format retrieved patterns into a prompt block bounded by maxChars.
 */
export function formatHistoricalMemoryForPrompt(
  patterns: HistoricalPatternMemory[],
  maxChars: number = MAX_SERIALIZED_CHARS,
): { serializedContext: string; truncated: boolean } {
  if (patterns.length === 0) {
    return { serializedContext: '', truncated: false };
  }

  const lines: string[] = [HISTORICAL_MEMORY_HEADER.trim(), '', 'OBSERVED RECURRING PATTERNS:'];

  let truncated = false;
  let currentLength = lines.join('\n').length + HISTORICAL_MEMORY_FOOTER.length + 10;

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const pathSnippet = p.relevantPaths.length > 0 ? ` (relevant paths: ${p.relevantPaths.slice(0, 3).join(', ')})` : '';
    const block = [
      `- [Pattern #${i + 1}] Category: ${p.category} | Across ${p.distinctPrCount} PR(s) (${p.acceptedCount} accepted, ${p.rejectedCount} rejected)`,
      `  Focus: ${p.summary}${pathSnippet}`,
      '',
    ].join('\n');

    if (currentLength + block.length > maxChars) {
      truncated = true;
      break;
    }

    lines.push(block);
    currentLength += block.length;
  }

  lines.push(HISTORICAL_MEMORY_FOOTER.trim());

  return {
    serializedContext: lines.join('\n'),
    truncated,
  };
}
