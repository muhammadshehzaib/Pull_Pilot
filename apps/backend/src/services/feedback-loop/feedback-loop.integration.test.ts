import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiSuggestion } from '../ai/finding-taxonomy';
const url = process.env.FEEDBACK_TEST_DATABASE_URL;
describe.skipIf(!url)('Phase 9 PostgreSQL integration', () => {
  let prisma: typeof import('../../config/prisma').default;
  let record: typeof import('../historical/occurrence.service').recordJobFindings;
  let feedback: typeof import('../historical/feedback.service').updateFeedback;
  let workflow: typeof import('./workflow.service').updateWorkflow;
  let events: typeof import('./workflow.service').workflowEvents;
  let draft: typeof import('./rule-conversion.service').prepareRuleDraft;
  let createRule: typeof import('./rule-conversion.service').createRuleFromFinding;
  let insights: typeof import('./adaptation.service').feedbackInsights;
  let settings: typeof import('./adaptation.service').updateAdaptation;
  let retrieve: typeof import('./adaptation.service').retrieveFeedbackAdaptation;
  let attribute: typeof import('./adaptation.service').adaptationAttribution;
  let rulesController: typeof import('../../controllers/rules.controller').RulesController;
  let sweep: typeof import('../../workers/historical-maintenance').sweepHistoricalOnce;
  let clear: typeof import('../../workers/historical-maintenance').clearRepositoryHistory;
  const owner = randomUUID(); let repo: string;
  const f: AiSuggestion = { filePath: 'src/Auth.ts', lineNumber: 10, agentType: 'STYLE', priority: 'LOW',
    source: 'LLM', issue: 'Naming convention mismatch', suggestion: 'Use the repository naming convention' };
  async function review(pr: string, findings = [f]) {
    const job = await prisma.analysisJob.create({ data: { repositoryId: repo, eventType: 'PULL_REQUEST', referenceId: pr,
      commitSha: randomUUID(), status: 'POSTING' } });
    await record(job.id, repo, findings, { suggestions: findings });
    const occurrence = await prisma.findingOccurrence.findFirstOrThrow({ where: { analysisJobId: job.id, superseded: false } });
    return { job, occurrence };
  }
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Explicit local disposable *_test database required');
    }
    prisma = (await import('../../config/prisma')).default;
    record = (await import('../historical/occurrence.service')).recordJobFindings;
    feedback = (await import('../historical/feedback.service')).updateFeedback;
    ({ updateWorkflow: workflow, workflowEvents: events } = await import('./workflow.service'));
    ({ prepareRuleDraft: draft, createRuleFromFinding: createRule } = await import('./rule-conversion.service'));
    ({ feedbackInsights: insights, updateAdaptation: settings, retrieveFeedbackAdaptation: retrieve, adaptationAttribution: attribute } = await import('./adaptation.service'));
    rulesController = (await import('../../controllers/rules.controller')).RulesController;
    ({ sweepHistoricalOnce: sweep, clearRepositoryHistory: clear } = await import('../../workers/historical-maintenance'));
    await prisma.user.create({ data: { id: owner, githubId: owner, username: 'phase9-test' } });
    repo = (await prisma.repository.create({ data: { userId: owner, fullName: 'phase9/disposable', githubRepoId: BigInt(Date.now() + 1000) } })).id;
  });
  afterAll(async () => { if (repo) await prisma.user.delete({ where: { id: owner } }); if (prisma) await prisma.$disconnect(); });
  it('serializes concurrent workflow edits, exact retries, restore, and separate feedback', async () => {
    const { job, occurrence: occ } = await review('workflow');
    const results = await Promise.allSettled([workflow(owner, job.id, occ.id, 'DISMISSED', 0), workflow(owner, job.id, occ.id, 'REPORTED_FIXED', 0)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const state = await prisma.findingWorkflow.findUniqueOrThrow({ where: { occurrenceId: occ.id } });
    await workflow(owner, job.id, occ.id, state.status, 0);
    await workflow(owner, job.id, occ.id, 'OPEN', 1);
    expect((await events(owner, job.id, occ.id)).map(e => e.revision)).toEqual([2, 1]);
    expect(await prisma.findingFeedback.count({ where: { occurrenceId: occ.id } })).toBe(0);
    await feedback({ occurrenceId: occ.id, actorId: owner, disposition: 'ACCEPTED', expectedRevision: 0 });
    expect((await prisma.findingWorkflow.findUniqueOrThrow({ where: { occurrenceId: occ.id } })).revision).toBe(2);
    await expect(workflow(randomUUID(), job.id, occ.id, 'DISMISSED', 2)).rejects.toMatchObject({ status: 404 });
    await expect(workflow(owner, randomUUID(), occ.id, 'DISMISSED', 2)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects stale/superseded and expired workflow operations', async () => {
    const { job, occurrence: occ } = await review('stale');
    await record(job.id, repo, [], { suggestions: [] });
    await expect(workflow(owner, job.id, occ.id, 'DISMISSED', 0)).rejects.toMatchObject({ status: 409 });
    const old = await review('expired');
    await prisma.analysisJob.update({ where: { id: old.job.id }, data: { createdAt: new Date(0) } });
    await expect(workflow(owner, old.job.id, old.occurrence.id, 'DISMISSED', 0)).rejects.toMatchObject({ status: 409 });
    await expect(draft(owner, old.job.id, old.occurrence.id)).rejects.toMatchObject({ status: 409 });
  });
  it('prepares an exact grounded, editable draft without persisting a rule', async () => {
    const { job, occurrence: occ } = await review('draft'); const before = await prisma.repositoryRule.count({ where: { repositoryId: repo } });
    const proposal = await draft(owner, job.id, occ.id);
    expect(proposal.draft).toMatchObject({ guideline: f.suggestion, category: 'STYLE', severity: 'LOW', enabled: false, enforcement: 'LLM' });
    expect(proposal.scope).toBe('REPOSITORY_WIDE');
    expect(await prisma.repositoryRule.count({ where: { repositoryId: repo } })).toBe(before);
    await expect(draft(randomUUID(), job.id, occ.id)).rejects.toMatchObject({ status: 404 });
  });
  it('requires confirmation, forbids executable patterns, and creates one rule/audit under retries', async () => {
    const { job, occurrence: occ } = await review('rule'); const proposal = await draft(owner, job.id, occ.id);
    const body = { ...proposal.draft, creationKey: proposal.creationKey, guideline: 'Prefer explicit naming in this repository' };
    await expect(createRule(owner, job.id, occ.id, body)).rejects.toMatchObject({ status: 400 });
    await expect(createRule(owner, job.id, occ.id, { ...body, confirmed: true, enforcement: 'DETERMINISTIC', pattern: '(a+)+$' })).rejects.toMatchObject({ status: 400 });
    const results = await Promise.all([createRule(owner, job.id, occ.id, { ...body, confirmed: true }), createRule(owner, job.id, occ.id, { ...body, confirmed: true })]);
    expect(results[0].rule.id).toBe(results[1].rule.id);
    expect(results.filter(r => r.reused)).toHaveLength(1);
    expect(results[0].rule).toMatchObject({ origin: 'FINDING', sourceOccurrenceId: occ.id, enabled: false });
    expect(await prisma.ruleAuditEvent.count({ where: { ruleId: results[0].rule.id, action: 'CREATED_FROM_FINDING' } })).toBe(1);
    expect(await prisma.findingFeedback.count({ where: { occurrenceId: occ.id } })).toBe(0);
    expect(await prisma.findingWorkflow.count({ where: { occurrenceId: occ.id } })).toBe(0);
    const another = await review('similar');
    const otherDraft = await draft(owner, another.job.id, another.occurrence.id);
    await expect(createRule(owner, another.job.id, another.occurrence.id, { ...body, creationKey: otherDraft.creationKey, confirmed: true })).rejects.toMatchObject({ status: 409 });
  });
  it('enables approved rules through the existing engine and rejects concurrent stale edits', async () => {
    const { mockReq, mockRes } = await import('../../test-utils/express-mocks');
    const rule = await prisma.repositoryRule.findFirstOrThrow({ where: { repositoryId: repo, origin: 'FINDING' } });
    const req = (body: unknown) => Object.assign(mockReq({ params: { repoId: repo, ruleId: rule.id }, body }), { auth: { userId: owner } });
    const responses = [mockRes(), mockRes()];
    await Promise.all(responses.map((res, i) => rulesController.update(req({ enabled: true, expectedRevision: 0, name: `Approved ${i}` }), res)));
    expect(responses.map(res => res.status.mock.calls.at(-1)?.[0]).sort()).toEqual([200, 409]);
    const active = await prisma.repositoryRule.findMany({ where: { repositoryId: repo, enabled: true } });
    const { RulesService } = await import('../rules.service');
    expect(RulesService.mergeGuidelines([], active)[0]).toContain('Prefer explicit naming');
    const unsafe = mockRes(); await rulesController.update(req({ expectedRevision: 1, enforcement: 'BOTH', pattern: '(a+)+$' }), unsafe);
    expect(unsafe.status).toHaveBeenLastCalledWith(400);
  });
  it('does not resurrect a deleted rule when a lost creation response is retried', async () => {
    const { job, occurrence: occ } = await review('deleted-rule');
    const proposal = await draft(owner, job.id, occ.id);
    const body = { ...proposal.draft, guideline: 'Use a distinct owner-approved guideline', creationKey: proposal.creationKey, confirmed: true };
    const result = await createRule(owner, job.id, occ.id, body);
    await prisma.repositoryRule.delete({ where: { id: result.rule.id } });
    await expect(createRule(owner, job.id, occ.id, body)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.repositoryRule.count({ where: { repositoryId: repo, creationKey: proposal.creationKey } })).toBe(0);
  });
  it('learns from distinct PR feedback, not repeated clicks, and leaves risk/findings unchanged', async () => {
    const learning: Array<Awaited<ReturnType<typeof review>>> = [];
    for (let i = 0; i < 5; i++) {
      const entry = await review(`learn-${i}`); learning.push(entry);
      await feedback({ occurrenceId: entry.occurrence.id, actorId: owner, disposition: 'REJECTED', rejectionReason: 'STYLE_PREFERENCE', expectedRevision: 0 });
    }
    // Existing 'workflow' acceptance is a sixth reviewed PR: 5/6 still qualifies.
    let snapshot = await insights(repo, owner);
    expect(snapshot.recommendations[0]).toMatchObject({ reviewedPrs: 6, rejectedPrs: 5 });
    expect(await retrieve(repo)).toBeNull();
    await settings(repo, owner, true, 0);
    const enabled = await retrieve(repo); const before = JSON.stringify([f]);
    expect(enabled?.serializedContext).toContain('UNTRUSTED FEEDBACK');
    expect(attribute([f], enabled)?.entries).toHaveLength(1); expect(JSON.stringify([f])).toBe(before);
    await workflow(owner, learning[0].job.id, learning[0].occurrence.id, 'DISMISSED', 0);
    expect((await insights(repo, owner)).recommendations[0].reviewedPrs).toBe(6);
    // A newer review/assessment of the same PR replaces its previous assessment.
    const repeated = await review('learn-0');
    await feedback({ occurrenceId: repeated.occurrence.id, actorId: owner, disposition: 'ACCEPTED', expectedRevision: 0 });
    snapshot = await insights(repo, owner); expect(snapshot.recommendations).toEqual([]);
    expect(attribute([f], await retrieve(repo))?.entries).toEqual([]);
    await settings(repo, owner, false, 1); expect(await retrieve(repo)).toBeNull();
    await expect(settings(repo, randomUUID(), true, 2)).rejects.toMatchObject({ status: 404 });
  });
  it('retention removes workflows/events and detaches rule provenance, without deleting approved rules', async () => {
    const rule = await prisma.repositoryRule.findFirstOrThrow({ where: { repositoryId: repo, sourceOccurrenceId: { not: null } } });
    const occ = await prisma.findingOccurrence.findUniqueOrThrow({ where: { id: rule.sourceOccurrenceId! } });
    await workflow(owner, occ.analysisJobId, occ.id, 'REPORTED_FIXED', 0);
    await prisma.analysisJob.update({ where: { id: occ.analysisJobId }, data: { createdAt: new Date(0) } });
    await sweep();
    expect(await prisma.findingWorkflow.count({ where: { occurrenceId: occ.id } })).toBe(0);
    expect((await prisma.repositoryRule.findUniqueOrThrow({ where: { id: rule.id } })).sourceOccurrenceId).toBeNull();
  });
  it('rolls back workflow state if an audit insertion fails', async () => {
    const { job, occurrence: occ } = await review('rollback');
    // Inject a failure only for our fixture actor, in this disposable database.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION phase9_test_audit_failure() RETURNS trigger AS $$ BEGIN
      IF NEW."actorId" = '${owner}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER phase9_test_audit_failure BEFORE INSERT ON finding_workflow_events FOR EACH ROW EXECUTE FUNCTION phase9_test_audit_failure()');
    try { await expect(workflow(owner, job.id, occ.id, 'DISMISSED', 0)).rejects.toThrow(); }
    finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER phase9_test_audit_failure ON finding_workflow_events');
      await prisma.$executeRawUnsafe('DROP FUNCTION phase9_test_audit_failure()');
    }
    expect(await prisma.findingWorkflow.count({ where: { occurrenceId: occ.id } })).toBe(0);
    await workflow(owner, job.id, occ.id, 'DISMISSED', 0);
  });
  it('disconnect clears workflow/feedback state and disables adaptation', async () => {
    await clear(repo);
    expect(await prisma.findingWorkflow.count({ where: { occurrence: { repositoryId: repo } } })).toBe(0);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repo } })).feedbackAdaptationEnabled).toBe(false);
    expect(await prisma.ruleAuditEvent.count({ where: { repositoryId: repo } })).toBe(0);
  });
});
