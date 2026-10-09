import { describe, it, expect } from 'vitest';
import { assessRisk, SEVERITY_WEIGHTS } from './risk-engine';
import type { AiSuggestion } from '../ai/finding-taxonomy';

function finding(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    filePath: 'src/app.ts',
    lineNumber: 10,
    agentType: 'SECURITY',
    issue: 'x',
    suggestion: 'y',
    priority: 'LOW',
    ...overrides,
  };
}

describe('risk engine — score', () => {
  it('sums severity weights and caps at 100', () => {
    const criticals = Array.from({ length: 6 }, () => finding({ priority: 'CRITICAL', source: 'SAST' }));
    const { report } = assessRisk(criticals);
    expect(SEVERITY_WEIGHTS.CRITICAL).toBe(30);
    // 6 * 30 = 180 -> capped.
    expect(report.score).toBe(100);
  });

  it('scores an empty list as SAFE with score 0', () => {
    const { report } = assessRisk([]);
    expect(report.score).toBe(0);
    expect(report.verdict).toBe('SAFE');
  });
});

describe('risk engine — verdicts', () => {
  it('BLOCKs on any CRITICAL security finding', () => {
    const { report } = assessRisk([finding({ priority: 'CRITICAL', source: 'SAST' })]);
    expect(report.verdict).toBe('BLOCK');
    expect(report.blockingCount).toBe(1);
  });

  it('BLOCKs on any SECRETS finding (credentials are facts)', () => {
    const { report } = assessRisk([finding({ priority: 'MEDIUM', source: 'SECRETS' })]);
    expect(report.verdict).toBe('BLOCK');
    expect(report.reasons.join()).toContain('credential');
  });

  it('honors the repository option that disables secret-triggered blocking', () => {
    const { report } = assessRisk(
      [finding({ priority: 'HIGH', source: 'SECRETS' })],
      { blockOnCriticalSecret: false },
    );
    expect(report.verdict).toBe('REVIEW');
    expect(report.blockingCount).toBe(0);
  });

  it('BLOCKs when the score reaches 75', () => {
    // 6 LOWs (2 each = 12) is too low; 3 CRITICAL via model findings (30 each = 90).
    const { report } = assessRisk([
      finding({ priority: 'CRITICAL', filePath: 'a.ts' }),
      finding({ priority: 'CRITICAL', filePath: 'b.ts' }),
      finding({ priority: 'CRITICAL', filePath: 'c.ts' }),
    ]);
    expect(report.verdict).toBe('BLOCK');
  });

  it('REVIEWs on any HIGH finding even below the score line', () => {
    const { report } = assessRisk([finding({ priority: 'HIGH' })]);
    expect(report.score).toBe(15);
    expect(report.verdict).toBe('REVIEW');
  });

  it('REVIEWs when the score passes 25 without blocking', () => {
    const findings = Array.from({ length: 5 }, () => finding({ priority: 'LOW' })); // 5 * 2 = 10
    const withMedium = [...findings, finding({ priority: 'MEDIUM' })]; // 10 + 10 = 20
    const withHigh = [...withMedium, finding({ priority: 'HIGH' })]; // 20 + 15 = 35
    const { report } = assessRisk(withHigh);
    expect(report.verdict).toBe('REVIEW');
  });

  it('stays SAFE for LOW/INFO noise', () => {
    const { report } = assessRisk([finding({ priority: 'INFO' })]);
    expect(report.verdict).toBe('SAFE');
  });
});

describe('risk engine — corroboration', () => {
  it('flags a probe finding corroborated by a model finding on the same lines', () => {
    const probe = finding({ priority: 'CRITICAL', source: 'SAST', lineNumber: 10 });
    const model = finding({ priority: 'HIGH', source: 'LLM', lineNumber: 8, issue: 'detected eval' });
    const { report, findings } = assessRisk([probe, model] as AiSuggestion[]);

    expect(report.corroboratedCount).toBe(1);
    const flagged = findings.find((f) => f.source === 'SAST');
    expect(flagged?.corroborated).toBe(true);
  });

  it('does not corroborate findings in different files', () => {
    const probe = finding({ priority: 'CRITICAL', source: 'SAST', lineNumber: 10, filePath: 'a.ts' });
    const model = finding({ priority: 'HIGH', source: 'LLM', lineNumber: 9, filePath: 'b.ts' });
    const { report, findings } = assessRisk([probe, model] as AiSuggestion[]);
    expect(report.corroboratedCount).toBe(0);
    expect(findings.find((f) => f.source === 'SAST')?.corroborated).toBeUndefined();
  });

  it('does not corroborate model-only findings (provenance preserved)', () => {
    const a = finding({ priority: 'HIGH', source: 'LLM', lineNumber: 4 });
    const b = finding({ priority: 'LOW', source: 'RULES', lineNumber: 5, filePath: 'other.ts' });
    const { report, findings } = assessRisk([a, b] as AiSuggestion[]);
    // Rules and LLM are not deterministic probes — no corroboration bookkeeping.
    expect(report.corroboratedCount).toBe(0);
    expect(findings.find((f) => f.source === 'LLM')?.corroborated).toBeUndefined();
  });
});

describe('risk engine — report shape', () => {
  it('groups security findings per probe and keeps categories', () => {
    const findings = [
      finding({ source: 'SAST', priority: 'CRITICAL' }),
      finding({ source: 'SECRETS', priority: 'MEDIUM' }),
      finding({ source: 'DEPENDENCIES', priority: 'HIGH', agentType: 'DEPENDENCY' }),
    ];
    const { report } = assessRisk(findings);
    expect(report.byProbe).toEqual({ SAST: 1, SECRETS: 1, DEPENDENCIES: 1 });
    expect(report.securityFindingCount).toBe(3);
    expect(report.categories).toContain('SECURITY');
  });

  it('does not mutate the input list', () => {
    const input = [finding({ priority: 'LOW', source: 'SAST' })];
    assessRisk(input);
    expect(input[0].corroborated).toBeUndefined();
  });
});
