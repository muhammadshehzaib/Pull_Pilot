import { createHash } from 'node:crypto';
import type { TestGapReport } from '../test-gap/test-gap-types';

export const LIMITS = { scenarios: 3, steps: 12, scenarioMs: 20_000, totalMs: 65_000, requests: 100, responseBytes: 2_000_000, totalBytes: 12_000_000, runsPerJob: 5, runsPerDay: 10, retentionDays: 7 } as const;
export const WORKFLOW_PATH = '.github/workflows/aipr-behavioral.yml';
export type Outcome = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'TIMED_OUT' | 'ERROR';
export type RunStatus = Outcome | 'QUEUED' | 'RUNNING';
export type Step =
  | { action: 'navigate'; path: string }
  | { action: 'click' | 'assertVisible'; testId: string }
  | { action: 'fill'; testId: string; fixture: 'EMPTY' | 'TEXT' | 'EMAIL' }
  | { action: 'assertText'; testId: string; text: string };
export interface Scenario { id: string; steps: Step[] }
export interface ScenarioResult { id: string; status: Outcome; steps: { index: number; status: Outcome }[] }
export interface BehavioralReport {
  version: 1;
  executor: 'OWNER_CI';
  scenarios: { id: string; filePath: string; description: string; stage: 'GENERATED' | 'EXECUTED' | 'VERIFIED'; status: Outcome; lastAssertionStatus?: 'PASSED' | 'FAILED'; lastAssertionRunId?: string; runId?: string }[];
  reason?: string;
  runId?: string;
  headSha?: string;
  ciRunId?: string;
}
export function scenarioId(gap: { filePath: string; scenario: string; lineNumber: number }): string {
  return createHash('sha256').update(JSON.stringify([gap.filePath, gap.lineNumber, gap.scenario])).digest('hex').slice(0, 24);
}
export function baselineBehavioral(gaps?: TestGapReport | null): BehavioralReport {
  return { version: 1, executor: 'OWNER_CI', reason: 'Execution is opt-in and requires an approved preview and owner CI.', scenarios: (gaps?.scenarios ?? []).slice(0, 8).map(g => ({ id: scenarioId(g), filePath: g.filePath.slice(0, 300), description: g.scenario.slice(0, 300), stage: 'GENERATED', status: 'NOT_RUN' })) };
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object');
  return v as Record<string, unknown>;
};
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new Error('Invalid or oversized string');
  return v;
}
export function parsePlan(value: unknown, allowedIds: string[]): Scenario[] {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.scenarios) throw new Error('Choose 1–3 scenarios');
  const seen = new Set<string>();
  return value.map(raw => {
    const s = object(raw); const id = text(s.id, 24);
    if (!allowedIds.includes(id) || seen.has(id)) throw new Error('Unknown or duplicate scenario');
    seen.add(id);
    if (!Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > LIMITS.steps) throw new Error('Each scenario needs 2–12 steps');
    const steps: Step[] = s.steps.map(rawStep => {
      const step = object(rawStep);
      if (step.action === 'navigate') {
        const path = text(step.path, 300);
        if (!/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(path) || path.includes('..')) throw new Error('Navigate accepts a simple relative path without query or fragment');
        return { action: 'navigate', path };
      }
      const testId = text(step.testId, 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(testId)) throw new Error('Use a simple data-testid');
      if (step.action === 'click' || step.action === 'assertVisible') return { action: step.action, testId };
      if (step.action === 'fill' && ['EMPTY', 'TEXT', 'EMAIL'].includes(String(step.fixture))) return { action: 'fill', testId, fixture: step.fixture as 'EMPTY' | 'TEXT' | 'EMAIL' };
      if (step.action === 'assertText') {
        const expected = text(step.text, 120);
        if (/(?:bearer |password|secret|token|sk-|gh[pousr]_|AKIA)[\s\S]*[a-z0-9]{8}/i.test(expected)) throw new Error('Sensitive assertion values are not accepted');
        return { action: 'assertText', testId, text: expected };
      }
      throw new Error('Unsupported action');
    });
    if (steps[0].action !== 'navigate' || !steps.some(s => s.action.startsWith('assert'))) throw new Error('Start with navigate and include an assertion');
    return { id, steps };
  });
}
/** Discard all runner-supplied text, URLs, screenshots and unknown fields. */
export function parseEvidence(value: unknown, plan: Scenario[]): ScenarioResult[] {
  if (!Array.isArray(value) || value.length !== plan.length) throw new Error('Evidence must cover the explicit plan');
  return plan.map((scenario, i) => {
    const item = object(value[i]);
    if (item.id !== scenario.id || !['PASSED', 'FAILED', 'NOT_RUN', 'TIMED_OUT', 'ERROR'].includes(String(item.status))) throw new Error('Invalid outcome');
    if (!Array.isArray(item.steps) || item.steps.length > scenario.steps.length) throw new Error('Invalid step evidence');
    const steps = item.steps.map((raw, index) => {
      const step = object(raw);
      if (step.index !== index || !['PASSED', 'FAILED', 'TIMED_OUT', 'ERROR'].includes(String(step.status))) throw new Error('Invalid step outcome');
      return { index, status: step.status as Outcome };
    });
    const status = item.status as Outcome;
    if (status === 'NOT_RUN' && steps.length) throw new Error('NOT_RUN cannot contain executed steps');
    if (steps.slice(0, -1).some(s => s.status !== 'PASSED')) throw new Error('Execution must stop on the first failing step');
    if (status === 'PASSED' && (steps.length !== scenario.steps.length || steps.some(s => s.status !== 'PASSED'))) throw new Error('PASS requires every step and assertion to execute');
    if (status === 'FAILED' && !steps.some(s => s.status === 'FAILED' && scenario.steps[s.index].action.startsWith('assert'))) throw new Error('FAIL requires an executed assertion failure');
    if (status !== 'PASSED' && status !== 'ERROR' && steps.length === scenario.steps.length && steps.every(s => s.status === 'PASSED')) throw new Error('Inconsistent evidence');
    return { id: scenario.id, status, steps };
  });
}
export function outcome(results: ScenarioResult[]): Outcome {
  if (results.some(r => r.status === 'FAILED')) return 'FAILED';
  if (results.some(r => r.status === 'TIMED_OUT')) return 'TIMED_OUT';
  if (results.some(r => r.status === 'ERROR')) return 'ERROR';
  return results.length > 0 && results.every(r => r.status === 'PASSED') ? 'PASSED' : 'NOT_RUN';
}
export function withExecution(baseline: BehavioralReport, results: ScenarioResult[], run: { id: string; headSha: string; ciRunId: string | null; reason?: string | null }): BehavioralReport {
  return { ...baseline, runId: run.id, headSha: run.headSha, ...(run.ciRunId ? { ciRunId: run.ciRunId } : {}), reason: run.reason || undefined, scenarios: baseline.scenarios.map(s => {
    const result = results.find(r => r.id === s.id);
    return result ? { ...s, status: result.status, stage: result.status === 'PASSED' ? 'VERIFIED' : result.steps.length > 0 ? 'EXECUTED' : 'GENERATED', runId: run.id,
      ...(['PASSED', 'FAILED'].includes(result.status) ? { lastAssertionStatus: result.status as 'PASSED' | 'FAILED', lastAssertionRunId: run.id } : {}) } : s;
  }) };
}
