import { describe, it, expect } from 'vitest';
import { RulesService, RuleRecord } from './rules.service';

function makeRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: 'rule-1',
    name: 'Rule',
    description: null,
    guideline: null,
    pattern: null,
    severity: 'MEDIUM',
    category: 'MAINTAINABILITY',
    enforcement: 'LLM',
    enabled: true,
    ...overrides,
  };
}

describe('RulesService.validateRule', () => {
  it('accepts an LLM rule and applies defaults', () => {
    const result = RulesService.validateRule({ name: 'No console.log', guideline: 'Never log secrets.' });

    expect(result).toEqual({
      rule: {
        name: 'No console.log',
        description: null,
        guideline: 'Never log secrets.',
        pattern: null,
        severity: 'MEDIUM',
        category: 'MAINTAINABILITY',
        enforcement: 'LLM',
        enabled: true,
      },
    });
  });

  it('accepts a DETERMINISTIC rule with only a pattern', () => {
    const result = RulesService.validateRule({
      name: 'No eval',
      enforcement: 'DETERMINISTIC',
      pattern: 'eval\\(',
      severity: 'HIGH',
      category: 'SECURITY',
    });

    expect(result).toEqual({
      rule: expect.objectContaining({
        enforcement: 'DETERMINISTIC',
        pattern: 'eval\\(',
        guideline: null,
        severity: 'HIGH',
        category: 'SECURITY',
      }),
    });
  });

  it('requires both guideline and pattern for BOTH', () => {
    expect(RulesService.validateRule({ name: 'x', enforcement: 'BOTH', guideline: 'g' })).toEqual({
      error: 'pattern is required when enforcement is BOTH',
    });
    expect(RulesService.validateRule({ name: 'x', enforcement: 'BOTH', pattern: 'p' })).toEqual({
      error: 'guideline is required when enforcement is BOTH',
    });
  });

  it('requires a guideline for LLM rules', () => {
    expect(RulesService.validateRule({ name: 'x' })).toEqual({
      error: 'guideline is required when enforcement is LLM',
    });
  });

  it('requires a pattern for DETERMINISTIC rules', () => {
    expect(RulesService.validateRule({ name: 'x', enforcement: 'DETERMINISTIC' })).toEqual({
      error: 'pattern is required when enforcement is DETERMINISTIC',
    });
  });

  it('rejects a pattern that does not compile', () => {
    const result = RulesService.validateRule({
      name: 'x',
      enforcement: 'DETERMINISTIC',
      pattern: '[unclosed',
    });

    expect('error' in result).toBe(true);
    expect(('error' in result ? result.error : '')).toMatch(/not a valid regular expression/);
  });

  it('rejects an uncompilable pattern even when enforcement is LLM', () => {
    const result = RulesService.validateRule({ name: 'x', guideline: 'g', pattern: '(unbalanced' });
    expect('error' in result && result.error).toMatch(/not a valid regular expression/);
  });

  it('rejects a missing name', () => {
    expect(RulesService.validateRule({ guideline: 'g' })).toEqual({ error: 'name is required' });
    expect(RulesService.validateRule({ name: '   ', guideline: 'g' })).toEqual({ error: 'name is required' });
  });

  it('rejects an over-long name', () => {
    const result = RulesService.validateRule({ name: 'a'.repeat(121), guideline: 'g' });
    expect(result).toEqual({ error: 'name must be at most 120 characters' });
  });

  it('rejects unknown enforcement, severity, and category values', () => {
    expect(RulesService.validateRule({ name: 'x', guideline: 'g', enforcement: 'MAGIC' })).toEqual({
      error: 'enforcement must be one of LLM, DETERMINISTIC, BOTH',
    });
    expect(RulesService.validateRule({ name: 'x', guideline: 'g', severity: 'APOCALYPTIC' })).toEqual({
      error: `severity must be one of CRITICAL, HIGH, MEDIUM, LOW, INFO`,
    });
    expect(RulesService.validateRule({ name: 'x', guideline: 'g', category: 'VIBES' })).toEqual({
      error: `category must be one of SECURITY, BUG, CORRECTNESS, PERFORMANCE, ARCHITECTURE, MAINTAINABILITY, STYLE, TESTING`,
    });
  });

  it('rejects a non-boolean enabled flag and a non-object body', () => {
    expect(RulesService.validateRule({ name: 'x', guideline: 'g', enabled: 'yes' })).toEqual({
      error: 'enabled must be a boolean',
    });
    expect(RulesService.validateRule('nope')).toEqual({ error: 'Rule body must be an object' });
  });

  it('trims free-text fields and treats empty strings as unset', () => {
    const result = RulesService.validateRule({
      name: '  Trimmed  ',
      guideline: '  statement  ',
      description: '',
      pattern: '   ',
    });

    expect(result).toEqual({
      rule: expect.objectContaining({ name: 'Trimmed', guideline: 'statement', description: null, pattern: null }),
    });
  });
});

describe('RulesService.mergeGuidelines', () => {
  it('appends LLM and BOTH rule wording after the .aipr.yml guidelines', () => {
    const merged = RulesService.mergeGuidelines(
      ['from the config file'],
      [
        makeRule({ name: 'Rule A', guideline: 'Do the thing.', enforcement: 'LLM' }),
        makeRule({ id: 'r2', name: 'Rule B', guideline: 'Also this.', enforcement: 'BOTH' }),
      ],
    );

    expect(merged).toEqual([
      'from the config file',
      '[Rule A] Do the thing.',
      '[Rule B] Also this.',
    ]);
  });

  it('excludes DETERMINISTIC-only rules — a regex is not prompt wording', () => {
    const merged = RulesService.mergeGuidelines(
      [],
      [makeRule({ name: 'No eval', pattern: 'eval\\(', enforcement: 'DETERMINISTIC' })],
    );

    expect(merged).toEqual([]);
  });

  it('returns the file guidelines untouched when there are no rules', () => {
    expect(RulesService.mergeGuidelines(['keep me'], [])).toEqual(['keep me']);
  });
});

describe('RulesService.evaluateRules', () => {
  it('evaluates catastrophic-backtracking patterns with the linear-time engine', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+' + 'a'.repeat(100000) + '!';
    const start = performance.now();
    const result = RulesService.evaluateRules([makeRule({ pattern: '(a+)+$', enforcement: 'DETERMINISTIC' })], diff);
    expect(result.checks[0].status).toBe('PASS');
    expect(result.violations).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('rejects unsupported backreferences and skips unsupported persisted rules', () => {
    const invalid = RulesService.validateRule({ name: 'unsafe syntax', enforcement: 'DETERMINISTIC', pattern: '(a)\\1' });
    expect(invalid).toHaveProperty('error');
    const result = RulesService.evaluateRules([makeRule({ pattern: '(?=a)', enforcement: 'DETERMINISTIC' })], 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+a');
    expect(result.checks[0].status).toBe('SKIPPED');
  });
  const diffWithEval =
    'diff --git a/src/app.ts b/src/app.ts\n' +
    '--- a/src/app.ts\n' +
    '+++ b/src/app.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' const a = 1;\n' +
    '+eval(userInput);\n' +
    ' console.log(a);';

  it('marks LLM-only rules SKIPPED instead of inventing pass or fail', () => {
    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'Wording rule', guideline: 'Do the thing.' })],
      diffWithEval,
    );

    expect(checks).toEqual([
      { ruleId: 'rule-1', ruleName: 'Wording rule', status: 'SKIPPED', violationCount: 0 },
    ]);
    expect(violations).toEqual([]);
  });

  it('FAILs a deterministic rule whose pattern matches an added line, with file and line', () => {
    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'No eval', description: 'eval() is forbidden', pattern: 'eval\\(', enforcement: 'DETERMINISTIC', severity: 'HIGH', category: 'SECURITY' })],
      diffWithEval,
    );

    expect(checks).toEqual([
      { ruleId: 'rule-1', ruleName: 'No eval', status: 'FAIL', violationCount: 1 },
    ]);
    expect(violations).toEqual([
      {
        filePath: 'src/app.ts',
        lineNumber: 2,
        agentType: 'SECURITY',
        source: 'RULES',
        ruleKeys: ['rule-1'],
        issue: 'Violates repository rule "No eval" — eval() is forbidden',
        suggestion: 'Update this line so it no longer violates the "No eval" rule.',
        priority: 'HIGH',
      },
    ]);
  });

  it('PASSes a deterministic rule that matches nothing', () => {
    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'No eval', pattern: 'eval\\(', enforcement: 'DETERMINISTIC' })],
      'diff body with no hunks at all',
    );

    expect(checks).toEqual([
      { ruleId: 'rule-1', ruleName: 'No eval', status: 'PASS', violationCount: 0 },
    ]);
    expect(violations).toEqual([]);
  });

  it('counts only added lines: deleted and context lines never violate', () => {
    const diff =
      'diff --git a/a.ts b/a.ts\n' +
      '--- a/a.ts\n' +
      '+++ b/a.ts\n' +
      '@@ -10,3 +10,4 @@\n' +
      ' const safe = forbidden();\n' +
      '-forbidden();\n' +
      '+const safe = 1;\n' +
      '+forbidden();\n' +
      ' const tail = 2;';

    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'No forbidden', pattern: 'forbidden\\(', enforcement: 'DETERMINISTIC' })],
      diff,
    );

    // The context line occupies new-file line 10, the "-" line takes no
    // new-file number at all, and the two "+" lines land on 11 and 12.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ filePath: 'a.ts', lineNumber: 12 });
    expect(checks[0]).toMatchObject({ status: 'FAIL', violationCount: 1 });
  });

  it('tracks line numbers across multiple hunks and files', () => {
    const diff =
      'diff --git a/one.ts b/one.ts\n' +
      '--- a/one.ts\n' +
      '+++ b/one.ts\n' +
      '@@ -1,1 +1,2 @@\n' +
      '+eval(1);\n' +
      'diff --git a/two.ts b/two.ts\n' +
      '--- a/two.ts\n' +
      '+++ b/two.ts\n' +
      '@@ -100,2 +100,3 @@\n' +
      ' ctx\n' +
      '+eval(2);';

    const { violations } = RulesService.evaluateRules(
      [makeRule({ name: 'No eval', pattern: 'eval\\(', enforcement: 'DETERMINISTIC' })],
      diff,
    );

    expect(violations.map((v) => [v.filePath, v.lineNumber])).toEqual([
      ['one.ts', 1],
      ['two.ts', 101],
    ]);
  });

  it('caps violations per rule so one runaway pattern cannot flood a PR', () => {
    const addedLines = Array.from({ length: 60 }, (_, i) => `+eval(${i});`).join('\n');
    const diff =
      'diff --git a/big.ts b/big.ts\n' +
      '--- a/big.ts\n' +
      '+++ b/big.ts\n' +
      '@@ -1,1 +1,61 @@\n' +
      addedLines;

    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'No eval', pattern: 'eval\\(', enforcement: 'DETERMINISTIC' })],
      diff,
    );

    expect(violations).toHaveLength(50);
    expect(checks[0]).toMatchObject({ status: 'FAIL', violationCount: 50 });
  });

  it('skips (not crashes on) a rule whose stored pattern does not compile', () => {
    const { checks, violations } = RulesService.evaluateRules(
      [makeRule({ name: 'Broken', pattern: '[unclosed', enforcement: 'DETERMINISTIC' })],
      diffWithEval,
    );

    expect(checks).toEqual([
      { ruleId: 'rule-1', ruleName: 'Broken', status: 'SKIPPED', violationCount: 0 },
    ]);
    expect(violations).toEqual([]);
  });

  it('evaluates each rule independently and returns one check per rule', () => {
    const { checks } = RulesService.evaluateRules(
      [
        makeRule({ id: 'r1', name: 'No eval', pattern: 'eval\\(', enforcement: 'DETERMINISTIC' }),
        makeRule({ id: 'r2', name: 'No env', pattern: 'process\\.env', enforcement: 'DETERMINISTIC' }),
        makeRule({ id: 'r3', name: 'Wording', guideline: 'Be nice.' }),
      ],
      diffWithEval,
    );

    expect(checks.map((c) => c.status)).toEqual(['FAIL', 'PASS', 'SKIPPED']);
  });
});
