import { describe, expect, it } from 'vitest';
import { baselineBehavioral, outcome, parseEvidence, parsePlan, withExecution } from './contracts';

const id = 'a'.repeat(24);
const steps = [{ action: 'navigate', path: '/' }, { action: 'assertVisible', testId: 'cart' }];
const plan = parsePlan([{ id, steps }], [id]);
describe('explicit behavioral plan', () => {
  it('requires an opening navigation, an assertion, known scenario and bounded actions', () => {
    expect(plan[0].steps).toHaveLength(2);
    for (const invalid of [[], [{ id: 'b'.repeat(24), steps }], [{ id, steps: [{ action: 'evaluate', code: 'fetch(...)' }] }], [{ id, steps: [steps[0], { action: 'click', testId: 'x' }] }], [{ id, steps: Array(13).fill(steps[0]) }]]) {
      expect(() => parsePlan(invalid, [id])).toThrow();
    }
  });
  it.each(['https://evil.com', '//evil.com', '/..', '/%2fadmin', '/?token=abc', '/#x', '/a\\b'])('rejects untrusted navigation %s', path => {
    expect(() => parsePlan([{ id, steps: [{ action: 'navigate', path }, steps[1]] }], [id])).toThrow();
  });
  it('cannot use selectors as code or supply credentials via fill', () => {
    expect(() => parsePlan([{ id, steps: [steps[0], { action: 'fill', testId: 'password', fixture: 'my-secret' }, steps[1]] }], [id])).toThrow();
    expect(() => parsePlan([{ id, steps: [steps[0], { action: 'assertVisible', testId: 'a"] script' }] }], [id])).toThrow();
  });
});
describe('behavioral evidence', () => {
  it('only verifies a fully executed passing plan and strips captured content', () => {
    const evidence = parseEvidence([{ id, status: 'PASSED', screenshot: 'secret', steps: [{ index: 0, status: 'PASSED', text: 'PII' }, { index: 1, status: 'PASSED' }] }], plan);
    expect(JSON.stringify(evidence)).not.toMatch(/secret|PII|screenshot/);
    expect(outcome(evidence)).toBe('PASSED');
    expect(() => parseEvidence([{ id, status: 'PASSED', steps: [] }], plan)).toThrow();
  });
  it('records assertion failures separately from timeouts and runner errors', () => {
    expect(outcome(parseEvidence([{ id, status: 'FAILED', steps: [{ index: 0, status: 'PASSED' }, { index: 1, status: 'FAILED' }] }], plan))).toBe('FAILED');
    expect(() => parseEvidence([{ id, status: 'FAILED', steps: [{ index: 0, status: 'FAILED' }] }], plan)).toThrow();
    for (const status of ['NOT_RUN', 'TIMED_OUT', 'ERROR'] as const) expect(outcome(parseEvidence([{ id, status, steps: [] }], plan))).toBe(status);
  });
  it('keeps missing Phase 5 and unexecuted/error scenarios unverified', () => {
    expect(baselineBehavioral().scenarios).toEqual([]);
    const base = { version: 1 as const, executor: 'OWNER_CI' as const, scenarios: [{ id, filePath: 'a.ts', description: 'cart', stage: 'GENERATED' as const, status: 'NOT_RUN' as const }] };
    expect(withExecution(base, [{ id, status: 'ERROR', steps: [] }], { id: 'r', headSha: 'h', ciRunId: null }).scenarios[0].stage).toBe('GENERATED');
  });
});
