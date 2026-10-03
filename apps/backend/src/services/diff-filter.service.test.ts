import { describe, it, expect } from 'vitest';
import { DiffFilterService } from './diff-filter.service';
import { AiPrConfig, DEFAULT_AIPR_CONFIG } from './config.service';

describe('DiffFilterService', () => {
  const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcdef 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+console.log('hello');
 
diff --git a/dist/bundle.js b/dist/bundle.js
index 1111111..2222222 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-var a=1;
+var a=2;

diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 "version": "1.0.0"
`;

  it('splits unified diff into per-file chunks', () => {
    const chunks = DiffFilterService.splitDiffByFile(sampleDiff);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].filename).toBe('src/index.ts');
    expect(chunks[1].filename).toBe('dist/bundle.js');
    expect(chunks[2].filename).toBe('package-lock.json');
  });

  it('filters out ignored files according to config', () => {
    const config: AiPrConfig = {
      ...DEFAULT_AIPR_CONFIG,
      ignore: ['dist/**', 'package-lock.json'],
    };

    const { filteredDiff, ignoredFiles, includedFiles } = DiffFilterService.filterDiff(sampleDiff, config);

    expect(ignoredFiles).toContain('dist/bundle.js');
    expect(ignoredFiles).toContain('package-lock.json');
    expect(includedFiles).toEqual(['src/index.ts']);
    expect(filteredDiff).toContain('src/index.ts');
    expect(filteredDiff).not.toContain('dist/bundle.js');
    expect(filteredDiff).not.toContain('package-lock.json');
  });

  it('enforces min_severity threshold', () => {
    expect(DiffFilterService.isSeverityMet('low', 'low')).toBe(true);
    expect(DiffFilterService.isSeverityMet('low', 'medium')).toBe(false);
    expect(DiffFilterService.isSeverityMet('medium', 'medium')).toBe(true);
    expect(DiffFilterService.isSeverityMet('high', 'medium')).toBe(true);
    expect(DiffFilterService.isSeverityMet('critical', 'high')).toBe(true);
    expect(DiffFilterService.isSeverityMet('high', 'critical')).toBe(false);
  });

  it('handles uppercase severities emitted by the AI model', () => {
    expect(DiffFilterService.isSeverityMet('CRITICAL', 'critical')).toBe(true);
    expect(DiffFilterService.isSeverityMet('HIGH', 'critical')).toBe(false);
    expect(DiffFilterService.isSeverityMet('CRITICAL', 'high')).toBe(true);
    expect(DiffFilterService.isSeverityMet('INFO', 'low')).toBe(false);
    expect(DiffFilterService.isSeverityMet('INFO', 'info')).toBe(true);
  });

  it('only lets CRITICAL findings through a critical threshold', () => {
    // Regression: min_severity: critical used to be unreachable, so users got
    // zero findings with no error. Every level below CRITICAL must be filtered.
    for (const level of ['HIGH', 'MEDIUM', 'LOW', 'INFO']) {
      expect(DiffFilterService.isSeverityMet(level, 'critical')).toBe(false);
    }
    expect(DiffFilterService.isSeverityMet('CRITICAL', 'critical')).toBe(true);
  });

  it('treats an unrecognised severity as INFO instead of dropping it at the default threshold', () => {
    // Previously unknown values ranked 0 and passed min_severity: low.
    // Keeping them at INFO keeps them visible when the threshold is lowered.
    expect(DiffFilterService.isSeverityMet('WAT', 'info')).toBe(true);
    expect(DiffFilterService.isSeverityMet('WAT', 'low')).toBe(false);
  });

  it('handles synonyms the model may emit', () => {
    expect(DiffFilterService.isSeverityMet('blocker', 'critical')).toBe(true);
    expect(DiffFilterService.isSeverityMet('nit', 'info')).toBe(true);
  });

  it('augments prompt with repository guidelines', () => {
    const config: AiPrConfig = {
      ...DEFAULT_AIPR_CONFIG,
      guidelines: ['Use strict camelCase', 'Avoid any keyword'],
    };

    const prompt = DiffFilterService.augmentPromptWithGuidelines('Base prompt', config);
    expect(prompt).toContain('Base prompt');
    expect(prompt).toContain('1. Use strict camelCase');
    expect(prompt).toContain('2. Avoid any keyword');
  });
});
