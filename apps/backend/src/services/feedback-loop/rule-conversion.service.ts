import { createHash } from 'node:crypto';
import prisma from '../../config/prisma';
import { RulesService } from '../rules.service';
import { normalizeStoredSuggestions } from '../ai/finding-taxonomy';
import { findingIdentity } from '../historical/occurrence.service';
import { eligibleFinding, LoopError } from './workflow.service';

export const ruleCreationKey = (id: string) => createHash('sha256').update(`finding-rule-v1:${id}`).digest('hex');
export function ruleSimilarityKey(rule: { name: string; guideline: string | null }) {
  return (rule.guideline || rule.name).trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function prepareRuleDraft(actorId: string, jobId: string, occurrenceId: string) {
  return prisma.$transaction(async tx => {
    const occ = await eligibleFinding(tx, actorId, jobId, occurrenceId);
    const artifact = occ.analysisJob.results;
    const findings = normalizeStoredSuggestions(Array.isArray(artifact) ? artifact :
      artifact && typeof artifact === 'object' ? (artifact as { suggestions?: unknown }).suggestions : []);
    const finding = findings.find(f => findingIdentity(f) === occ.findingKey);
    if (!finding) throw new LoopError(409, 'Exact finding unavailable; reload the review');
    const draft = { name: finding.issue.slice(0, 120), description: `Proposed from ${finding.filePath}:${finding.lineNumber}`.slice(0, 500),
      guideline: finding.suggestion.slice(0, 2000), category: finding.agentType, severity: finding.priority,
      enforcement: 'LLM' as const, pattern: null, enabled: false };
    const existing = await tx.repositoryRule.findMany({ where: { repositoryId: occ.repositoryId }, take: 501 });
    return { draft, creationKey: ruleCreationKey(occ.id), scope: 'REPOSITORY_WIDE', unvalidated: true,
      similarRules: existing.filter(r => r.creationKey === ruleCreationKey(occ.id) ||
        ruleSimilarityKey(r) === ruleSimilarityKey(draft)).slice(0, 10).map(r => ({ id: r.id, name: r.name })),
      repositoryId: occ.repositoryId };
  });
}

export async function createRuleFromFinding(actorId: string, jobId: string, occurrenceId: string, body: Record<string, unknown>) {
  if (body.confirmed !== true) throw new LoopError(400, 'Explicit confirmation is required');
  if (body.creationKey !== ruleCreationKey(occurrenceId)) throw new LoopError(400, 'Invalid creation key');
  // Finding-derived patterns cannot become executable regular expressions.
  if (body.enforcement !== 'LLM' || body.pattern) throw new LoopError(400, 'Finding-derived rules support Model enforcement only');
  const parsed = RulesService.validateRule({ ...body, enabled: body.enabled ?? false });
  if ('error' in parsed) throw new LoopError(400, parsed.error);
  return prisma.$transaction(async tx => {
    const occ = await eligibleFinding(tx, actorId, jobId, occurrenceId);
    const rules = await tx.repositoryRule.findMany({ where: { repositoryId: occ.repositoryId }, take: 501 });
    const priorCreation = await tx.ruleAuditEvent.findFirst({ where: { repositoryId: occ.repositoryId, creationKey: body.creationKey as string } });
    const existing = rules.find(r => r.creationKey === body.creationKey);
    if (existing) return { rule: existing, reused: true };
    if (priorCreation) throw new LoopError(409, 'This rule was already created and subsequently deleted. Open repository rules to make a new decision.');
    if (rules.length >= 500) throw new LoopError(409, 'Repository rule limit reached');
    const similar = rules.find(r => ruleSimilarityKey(r) === ruleSimilarityKey(parsed.rule));
    if (similar) throw new LoopError(409, `A similar rule already exists; open repository rules before creating another`);
    const rule = await tx.repositoryRule.create({ data: { ...parsed.rule, repositoryId: occ.repositoryId,
      origin: 'FINDING', sourceOccurrenceId: occ.id, creationKey: body.creationKey as string } });
    await tx.ruleAuditEvent.create({ data: { repositoryId: occ.repositoryId, ruleId: rule.id,
      actorId, action: 'CREATED_FROM_FINDING', revision: rule.revision, creationKey: body.creationKey as string } });
    return { rule, reused: false };
  });
}
