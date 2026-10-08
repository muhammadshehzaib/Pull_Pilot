import { describe, it, expect } from 'vitest';
import {
  probeLabel,
  verdictLabel,
  riskTone,
  isBlockingVerdict,
  probeTally,
  type RiskReport,
  type SecurityCheck,
} from './security';
import { sourceLabel } from './review';

const baseReport: RiskReport = {
  score: 30,
  verdict: 'REVIEW',
  blockingCount: 0,
  securityFindingCount: 3,
  corroboratedCount: 1,
  categories: ['SECURITY'],
  byProbe: { SAST: 2, SECRETS: 0, DEPENDENCIES: 1 },
  reasons: ['High-severity finding requires attention'],
};

describe('probe labels', () => {
  it('labels every probe', () => {
    expect(probeLabel('SAST')).toBe('Static analysis');
    expect(probeLabel('SECRETS')).toBe('Secrets');
    expect(probeLabel('DEPENDENCIES')).toBe('Dependencies');
  });

  it('reads unknown probes as their raw text instead of crashing', () => {
    expect(probeLabel('THREAT')).toBe('THREAT');
  });
});

describe('verdict helpers', () => {
  it('labels every verdict', () => {
    expect(verdictLabel('BLOCK')).toBe('Block');
    expect(verdictLabel('REVIEW')).toBe('Review');
    expect(verdictLabel('SAFE')).toBe('Safe');
  });

  it('reads unknown verdicts as their raw text', () => {
    expect(verdictLabel('PANIC')).toBe('PANIC');
  });

  it('only calls BLOCK a blocking verdict', () => {
    expect(isBlockingVerdict('BLOCK')).toBe(true);
    expect(isBlockingVerdict('REVIEW')).toBe(false);
    expect(isBlockingVerdict('SAFE')).toBe(false);
  });
});

describe('risk tone', () => {
  it('tracks the backend blocking thresholds verbatim', () => {
    expect(riskTone(24)).toBe('safe');
    expect(riskTone(25)).toBe('review');
    expect(riskTone(74)).toBe('review');
    expect(riskTone(75)).toBe('block');
    expect(riskTone(100)).toBe('block');
  });
});

describe('probe tally', () => {
  it('renders one row per probe in probe order, zero counts included', () => {
    expect(probeTally(baseReport)).toEqual([
      { probe: 'SAST', count: 2 },
      { probe: 'SECRETS', count: 0 },
      { probe: 'DEPENDENCIES', count: 1 },
    ]);
  });

  it('defaults a missing tally object to zeros', () => {
    expect(probeTally({ ...baseReport, byProbe: {} as RiskReport['byProbe'] })).toEqual([
      { probe: 'SAST', count: 0 },
      { probe: 'SECRETS', count: 0 },
      { probe: 'DEPENDENCIES', count: 0 },
    ]);
  });
});

describe('source labels', () => {
  it('maps every provenance to a short badge label', () => {
    expect(sourceLabel('LLM')).toBe('Model');
    expect(sourceLabel('RULES')).toBe('Rule');
    expect(sourceLabel('SAST')).toBe('SAST');
    expect(sourceLabel('SECRETS')).toBe('Secrets');
    expect(sourceLabel('DEPENDENCIES')).toBe('Deps');
  });

  it('treats missing and unknown sources as model findings', () => {
    expect(sourceLabel(undefined)).toBe('Model');
    expect(sourceLabel('CONFUSED')).toBe('Model');
  });
});

describe('check row shape', () => {
  it('accepts the SecurityCheck row the API returns', () => {
    const row: SecurityCheck = {
      id: 'ck-1',
      probe: 'SAST',
      ruleKey: 'sast-sql-template',
      ruleName: 'SQL template literal',
      status: 'FAIL',
      findingCount: 2,
      createdAt: '2026-10-08T00:00:00.000Z',
    };
    expect(row.status).toBe('FAIL');
    expect(row.probe).toBe('SAST');
  });
});