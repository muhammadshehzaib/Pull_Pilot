/**
 * Occurrence service — Phase 8 Historical Intelligence
 *
 * Persists FindingOccurrence rows for a completed analysis job.
 *
 * Safety invariants:
 *  - Each (jobId, arrayIndex) is idempotent via the unique snapshotKey, so
 *    BullMQ retries and superseded snapshots never create duplicate rows.
 *  - "Superseded" snapshots: if the worker writes results more than once for
 *    the same job (e.g. a crash/retry between the intermediate results write
 *    and the COMPLETED write), previously written occurrences are marked
 *    superseded and a fresh batch is written.
 *  - No writes are performed on GET requests; this service is only called
 *    from the analysis worker, never from any HTTP handler.
 *  - If this service throws, the worker catches and logs but does NOT abort
 *    the review — occurrence recording is best-effort.
 */

import prisma from '../../config/prisma';
import type { AiSuggestion } from '../ai/finding-taxonomy';
import { generateFingerprint, buildFindingSummary } from './fingerprint.service';

/**
 * Record all merged findings for a completed job as FindingOccurrence rows.
 *
 * @param jobId         The AnalysisJob primary key
 * @param repositoryId  The owning repository's primary key
 * @param findings      The final merged+deduplicated findings array
 * @param snapshotSeq   Monotonic integer from the worker (0 = first/only attempt).
 *                      Used to build idempotency keys and to mark previous rows.
 */
export async function recordJobFindings(
  jobId: string,
  repositoryId: string,
  findings: AiSuggestion[],
  snapshotSeq: number = 0,
): Promise<void> {
  if (findings.length === 0) return;

  // Mark any occurrences from earlier snapshots of this job as superseded.
  // This covers the edge case of a crash/retry that wrote a partial batch.
  // Uses updateMany to avoid a race window: only touches rows for this job
  // where snapshotKey does NOT start with the current snapshotSeq prefix.
  const currentPrefix = `${jobId}:${snapshotSeq}:`;
  await prisma.findingOccurrence.updateMany({
    where: {
      analysisJobId: jobId,
      superseded: false,
      NOT: { snapshotKey: { startsWith: currentPrefix } },
    },
    data: { superseded: true },
  });

  // Build rows. We use createMany with skipDuplicates so a retry that reaches
  // this point after the superseded-mark above never double-inserts.
  const rows = findings.map((finding, index) => {
    const source = finding.source ?? 'LLM';
    return {
      repositoryId,
      analysisJobId: jobId,
      snapshotKey: `${currentPrefix}${index}`,
      filePath: finding.filePath,
      lineNumber: finding.lineNumber,
      category: finding.agentType,
      severity: finding.priority,
      source,
      sources: (finding.sources ?? [source]) as unknown as any,
      ruleKeys: (finding.ruleKeys ?? []) as unknown as any,
      summary: buildFindingSummary(finding),
      fingerprint: generateFingerprint(finding),
      superseded: false,
    };
  });

  await prisma.findingOccurrence.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(
    `📝 [Phase8] Recorded ${rows.length} finding occurrence(s) for job ${jobId} (snapshotSeq=${snapshotSeq}).`,
  );
}
