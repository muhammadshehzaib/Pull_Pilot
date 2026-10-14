import { createHash } from 'node:crypto';
import type { TestGapReport } from '../test-gap/test-gap-types';

export const LIMITS = { scenarios: 3, steps: 12, scenarioMs: 20_000, totalMs: 65_000, requests: 100, responseBytes: 2_000_000, totalBytes: 12_000_000, runsPerJob: 5, runsPerDay: 10, retentionDays: 7 } as const;
export const WORKFLOW_PATH = '.github/workflows/aipr-behavioral.yml';
export type Outcome = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'TIMED_OUT' | 'ERROR';
export type RunStatus = Outcome | 'QUEUED' | 'RUNNING';
export type Step =
  | { action: 'navigate'; path: string }
  | { action: 'authenticate'; fixture: 'CUSTOMER' }
  | { action: 'assertJson'; path: string; pointer: string; equals: string | number | boolean | null }
  | { action: 'click' | 'assertVisible'; testId: string }
  | { action: 'fill'; testId: string; fixture: 'EMPTY' | 'TEXT' | 'EMAIL' }
  | { action: 'assertText'; testId: string; text: string };
export interface Scenario { id: string; steps: Step[] }
export interface SandboxConfig {
  dockerfile: string; port: number; readyPath: string; sessionPath?: string;
  mutations: { method: string; path: string }[]; assertions: string[];
}
export type Execution = { mode: 'PUBLIC_PREVIEW' } | { mode: 'OWNER_SANDBOX'; sandbox: SandboxConfig };
export function simplePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300 || !/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(value) || value.includes('..')) throw new Error('Use a simple relative path');
  return value;
}
export function parseExecution(value: unknown): Execution {
  const c = object(value);
  if (c.mode === undefined || c.mode === 'PUBLIC_PREVIEW') return { mode: 'PUBLIC_PREVIEW' };
  if (c.mode !== 'OWNER_SANDBOX') throw new Error('Unsupported execution mode');
  const s = object(c.sandbox);
  const dockerfile = text(s.dockerfile, 200);
  if (!/^[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(dockerfile) || dockerfile.startsWith('/') || dockerfile.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Invalid Dockerfile path');
  if (!Number.isInteger(s.port) || Number(s.port) < 1024 || Number(s.port) > 65535) throw new Error('Invalid app port');
  if (!Array.isArray(s.mutations) || s.mutations.length > 20 || !Array.isArray(s.assertions) || !s.assertions.length || s.assertions.length > 20) throw new Error('Bound mutation and assertion endpoints');
  const sessionPath = s.sessionPath === undefined ? undefined : simplePath(s.sessionPath);
  const assertions = [...new Set(s.assertions.map(simplePath))];
  const mutations = s.mutations.map(raw => {
    const m = object(raw);
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(m.method))) throw new Error('Invalid mutation method');
    const path = simplePath(m.path);
    if (path === sessionPath || assertions.includes(path)) throw new Error('Control endpoints cannot be mutation endpoints');
    return { method: String(m.method), path };
  });
  if (sessionPath && assertions.includes(sessionPath)) throw new Error('Control endpoints must be distinct');
  return { mode: 'OWNER_SANDBOX', sandbox: { dockerfile, port: Number(s.port), readyPath: simplePath(s.readyPath), ...(sessionPath ? { sessionPath } : {}), mutations, assertions } };
}
export function storedPlan(value: unknown): { scenarios: Scenario[]; execution: Execution } {
  if (Array.isArray(value)) return { scenarios: value as Scenario[], execution: { mode: 'PUBLIC_PREVIEW' } };
  const p = object(value);
  if (p.version !== 2 || !Array.isArray(p.scenarios)) throw new Error('Invalid stored plan');
  return { scenarios: p.scenarios as Scenario[], execution: parseExecution(p.execution) };
}
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
export function parsePlan(value: unknown, allowedIds: string[], execution: Execution = { mode: 'PUBLIC_PREVIEW' }): Scenario[] {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.scenarios) throw new Error('Choose 1–3 scenarios');
  const seen = new Set<string>();
  return value.map(raw => {
    const s = object(raw); const id = text(s.id, 24);
    if (!allowedIds.includes(id) || seen.has(id)) throw new Error('Unknown or duplicate scenario');
    seen.add(id);
    if (!Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > LIMITS.steps) throw new Error('Each scenario needs 2–12 steps');
    const steps: Step[] = s.steps.map(rawStep => {
      const step = object(rawStep);
      if (step.action === 'authenticate') {
        if (execution.mode !== 'OWNER_SANDBOX' || !execution.sandbox.sessionPath || step.fixture !== 'CUSTOMER') throw new Error('Synthetic customer authentication is unavailable');
        return { action: 'authenticate', fixture: 'CUSTOMER' };
      }
      if (step.action === 'assertJson') {
        if (execution.mode !== 'OWNER_SANDBOX' || !execution.sandbox.assertions.includes(simplePath(step.path))) throw new Error('Unapproved state assertion endpoint');
        const pointer = text(step.pointer, 120);
        if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(pointer) || pointer.split('/').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('Invalid JSON pointer');
        const expected = step.equals;
        if (!(expected === null || typeof expected === 'boolean' || (typeof expected === 'number' && Number.isFinite(expected)) || (typeof expected === 'string' && expected.length <= 120 && !/[\x00-\x1f\x7f]/.test(expected)))) throw new Error('Use a primitive expected value');
        if (typeof expected === 'string' && /(?:bearer |password|secret|token|sk-|gh[pousr]_|AKIA)[\s\S]*[a-z0-9]{8}/i.test(expected)) throw new Error('Sensitive assertion values are not accepted');
        return { action: 'assertJson', path: String(step.path), pointer, equals: expected as string | number | boolean | null };
      }
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
