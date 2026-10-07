import { describe, it, expect } from 'vitest';
import { isVulnerable, minSelectableVersion, parseVersion, advisoriesFor } from './advisory-registry';

describe('parseVersion', () => {
  it('parses major.minor.patch and tolerates pre-release suffixes', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('v4.17.14-alpha.1').patch).toBe(14);
    expect(parseVersion('2.6')).toEqual({ major: 2, minor: 6, patch: 0 });
    expect(parseVersion('garbage')).toBeNull();
  });
});

describe('minSelectableVersion', () => {
  it('treats caret, tilde, exact and >= specs by their lower bound', () => {
    expect(minSelectableVersion('^1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(minSelectableVersion('~1.2')).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(minSelectableVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(minSelectableVersion('>=0.5.0')).toEqual({ major: 0, minor: 5, patch: 0 });
    expect(minSelectableVersion('1.x')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('returns null for wildcard / upper-bound-only specs (treat as potentially vulnerable)', () => {
    for (const spec of ['*', 'latest', '<2.0.0', '<=1.0.0', 'x']) {
      expect(minSelectableVersion(spec)).toBeNull();
    }
  });
});

describe('isVulnerable', () => {
  const lodash = advisoriesFor('lodash')[0];
  const nodeFetchV2 = advisoriesFor('node-fetch').find((a) => a.major === 2)!;
  const nodeFetchV3 = advisoriesFor('node-fetch').find((a) => a.major === 3)!;

  it('flags a caret spec whose minimum is below the fixed bound', () => {
    expect(isVulnerable('^4.17.14', lodash)).toBe(true);
    expect(isVulnerable('^4.17.21', lodash)).toBe(false);
    expect(isVulnerable('4.17.21', lodash)).toBe(false);
  });

  it('treats wildcard specs as vulnerable (any resolution may pick a bad version)', () => {
    expect(isVulnerable('*', lodash)).toBe(true);
    expect(isVulnerable('latest', lodash)).toBe(true);
  });

  it('respects major-scoped advisories', () => {
    expect(isVulnerable('^2.6.5', nodeFetchV2)).toBe(true);
    expect(isVulnerable('^2.6.9', nodeFetchV2)).toBe(false);
    expect(isVulnerable('^3.0.0', nodeFetchV2)).toBe(false); // different major, not this advisory
    expect(isVulnerable('^3.3.0', nodeFetchV3)).toBe(true);
    expect(isVulnerable('^3.3.1', nodeFetchV3)).toBe(false);
  });
});