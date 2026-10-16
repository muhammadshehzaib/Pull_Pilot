const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sha, findingId, estimateCost, labelTemplate, score, quantile, compare } = require('./lib.cjs');
function fixture() {
  const corpus = { cases: [
    { id: 'bug', family: 'seeded', category: 'logic', variant: 'bug', expectedBugs: [{ id: 'b1', terms: ['null'] }] },
    { id: 'clean', family: 'seeded', category: 'logic', variant: 'clean', expectedBugs: [] },
  ] };
  const run = { id: 'r1', mode: 'scanners', corpusSha256: sha(JSON.stringify(corpus, null, 2) + '\n'), results: [
    { caseId: 'bug', repetition: 1, status: 'ok', durationMs: 20, costUsd: 0, findings: [{ issue: 'Null dereference', suggestion: 'Guard' }] },
    { caseId: 'clean', repetition: 1, status: 'ok', durationMs: 10, costUsd: 0, findings: [{ issue: 'Unsupported claim', suggestion: 'Rewrite' }] },
  ] };
  return { corpus, run, labels: labelTemplate(run, corpus) };
}
test('keyword candidates never automatically create true or false positives', () => {
  const { run, corpus, labels } = fixture();
  assert.deepEqual(labels.labels[0].candidates, ['b1']);
  const m = score(run, corpus, labels).overall;
  assert.equal(m.recall, null); assert.equal(m.precision, null); assert.equal(m.falseComments, 0); assert.equal(m.pendingComments, 2);
});
test('recall, precision, clean false-comment rate and duplicate noise are distinct', () => {
  const { run, corpus, labels } = fixture();
  labels.reviewer = 'test reviewer';
  Object.assign(labels.labels[0], { verdict: 'tp', bugId: 'b1', rationale: 'Reproduces the null input.' });
  Object.assign(labels.labels[1], { verdict: 'fp', rationale: 'The guard already rejects this input.' });
  run.results[0].findings.push({ issue: 'Same null bug twice', suggestion: 'Guard it' });
  labels.labels.push({ findingId: findingId('bug', 1, 1, run.results[0].findings[1]), caseId: 'bug', verdict: 'tp', bugId: 'b1', rationale: 'Same defect.' });
  const m = score(run, corpus, labels).overall;
  assert.equal(m.recall, 1); assert.equal(m.precision, .5); assert.equal(m.duplicateComments, 1);
  assert.equal(m.precisionCountingDuplicatesAsNoise, 1 / 3); assert.equal(m.cleanCaseFalseCommentRate, 1);
});
test('failed cases stay in recall denominator and unknown costs never become zero', () => {
  const { run, corpus } = fixture();
  run.results[0] = { ...run.results[0], status: 'error', findings: [], costUsd: null };
  run.results[1].findings = [];
  const m = score(run, corpus, labelTemplate(run, corpus)).overall;
  assert.equal(m.recall, 0); assert.equal(m.precision, null); assert.equal(m.failures, 1); assert.equal(m.costUsd, null);
});
test('cross-case labels, stale corpus, duplicates and orphan duplicates are rejected', () => {
  const { run, corpus, labels } = fixture();
  labels.reviewer = 'test';
  Object.assign(labels.labels[1], { verdict: 'tp', bugId: 'b1', rationale: 'bad cross-case' });
  assert.throws(() => score(run, corpus, labels), /same case/);
  labels.labels[1].verdict = 'pending';
  labels.labels.push(labels.labels[0]);
  assert.throws(() => score(run, corpus, labels), /duplicate adjudication/);
  labels.labels.pop(); labels.runId = 'wrong';
  assert.throws(() => score(run, corpus, labels), /another run/);
  labels.runId = run.id;
  Object.assign(labels.labels[0], { verdict: 'duplicate', bugId: 'b1', rationale: 'no first detection' });
  assert.throws(() => score(run, corpus, labels), /no confirmed detection/);
  corpus.cases[0].category = 'changed';
  assert.throws(() => score(run, corpus, labels), /does not match/);
});
test('cost requires recorded usage, exact model rates and cache accounting', () => {
  const usage = [{ provider: 'OPENAI', model: 'm', inputTokens: 1000, outputTokens: 2000, cachedInputTokens: 100, cacheWriteTokens: 0 }];
  const rates = { models: { 'OPENAI:m': { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 1 } } };
  assert.equal(estimateCost(usage, rates), .0179);
  assert.equal(estimateCost([], rates), null);
  assert.equal(estimateCost(usage, null), null);
  assert.equal(estimateCost([{ ...usage[0], cachedInputTokens: null }], rates), null);
  assert.equal(estimateCost([{ ...usage[0], cacheWriteTokens: 1 }], rates), null);
  assert.equal(estimateCost([{ ...usage[0], model: 'different' }], rates), null);
});
test('nearest-rank percentiles handle small or empty samples honestly', () => {
  assert.equal(quantile([], .95), null); assert.equal(quantile([1, 20, 3], .95), 20);
});
test('comparison rejects mismatched inputs and discloses incompatible timing scopes', () => {
  const { run, corpus, labels } = fixture();
  run.timingScope = 'review-core';
  run.results.forEach(r => { r.inputSha256 = sha(r.caseId); });
  const report = score(run, corpus, labels);
  const other = structuredClone(run);
  other.timingScope = 'end-to-end';
  const result = compare(run, other, report, report);
  assert.equal(result.timingComparable, false); assert.equal(result.recallDifference, null);
  other.results[0].inputSha256 = 'changed';
  assert.throws(() => compare(run, other, report, report), /identical/);
});
