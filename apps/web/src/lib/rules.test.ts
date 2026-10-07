import { describe, it, expect } from 'vitest';
import {
  CHECK_STATUS_LABELS,
  ENFORCEMENT_HINTS,
  ENFORCEMENT_LABELS,
  summarizeChecks,
  type RuleCheck,
} from './rules';

const check = (overrides: Partial<RuleCheck> = {}): RuleCheck => ({
  id: 'c-1',
  ruleId: 'r-1',
  ruleName: 'No eval',
  status: 'PASS',
  violationCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('lib/rules vocabulary', () => {
  it('labels every enforcement mode and provides a hint for each', () => {
    for (const mode of ['LLM', 'DETERMINISTIC', 'BOTH'] as const) {
      expect(ENFORCEMENT_LABELS[mode]).toBeTypeOf('string');
      expect(ENFORCEMENT_HINTS[mode]).toBeTypeOf('string');
    }
  });

  it('labels every check status', () => {
    for (const status of ['PASS', 'FAIL', 'SKIPPED'] as const) {
      expect(CHECK_STATUS_LABELS[status]).toBeTypeOf('string');
    }
  });
});

describe('summarizeChecks', () => {
  it('describes a single status', () => {
    expect(summarizeChecks([check({ status: 'PASS' })])).toBe('1 passed');
    expect(summarizeChecks([check({ status: 'FAIL', violationCount: 3 })])).toBe('1 failed');
    expect(summarizeChecks([check({ status: 'SKIPPED' })])).toBe('1 model-enforced');
  });

  it('combines statuses with a comma', () => {
    const checks = [
      check({ id: '1', status: 'PASS' }),
      check({ id: '2', ruleName: 'No env', status: 'FAIL', violationCount: 2 }),
      check({ id: '3', ruleName: 'Doc style', status: 'SKIPPED' }),
      check({ id: '4', ruleName: 'Other', status: 'PASS' }),
    ];
    expect(summarizeChecks(checks)).toBe('2 passed, 1 failed, 1 model-enforced');
  });

  it('returns an empty string when there are no checks', () => {
    expect(summarizeChecks([])).toBe('');
  });
});