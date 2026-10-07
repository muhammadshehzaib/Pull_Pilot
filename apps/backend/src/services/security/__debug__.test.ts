import { describe, it, expect } from 'vitest';
import { scanDependencies } from './probes/deps';
import { isVulnerable, minSelectableVersion, advisoriesFor } from './advisory-registry';

function npmDiff(added: string[], removed: string[] = []): string {
  const lines = ['diff --git a/package.json b/package.json','--- a/package.json','+++ b/package.json','@@ -1,1 +1,1 @@',' {','   "name": "app",','   "dependencies": {'];
  for (const r of removed) lines.push(`-    ${r}`);
  for (const a of added) lines.push(`+    ${a}`);
  lines.push('   },',' }');
  return lines.join('\n');
}

describe('debug', () => {
  it('menu', () => {
    console.log('axios-0.19', JSON.stringify(scanDependencies(npmDiff(['"axios": "^0.19.0",'])).findings.map((x) => ({ k: x.ruleKey, p: x.priority }))));
    console.log('axios-1.8', JSON.stringify(scanDependencies(npmDiff(['"axios": "^1.8.0",'])).findings.map((x) => ({ k: x.ruleKey, p: x.priority, issue: x.issue }))));
    console.log('lodash-4.17.22', JSON.stringify(scanDependencies(npmDiff(['"lodash": "^4.17.22",'])).findings.map((x) => ({ k: x.ruleKey, p: x.priority, issue: x.issue }))));
    console.log('pillow', JSON.stringify(scanDependencies('diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n@@ -1,1 +1,1 @@\n+Pillow>=8.0.0').findings.map((x) => ({ k: x.ruleKey, p: x.priority, issue: x.issue }))));
    const req = 'diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n@@ -1,1 +1,1 @@\n+Pillow>=8.0.0';
    const { DiffFilterService } = require('../../diff-filter.service') as typeof import('../../diff-filter.service');
    const raws = DiffFilterService.splitDiffByFile(req)[0]?.content.split('\n') ?? [];
    console.log('reqRaw', JSON.stringify(raws));
    console.log('reqTexts', JSON.stringify(raws.map((t) => t.replace(/^[+-]/, '').trim()).filter((t) => t.length > 0 && !/^(diff --git|---|\+\+\+|@@|\\\\)/.test(t))));
    console.log('pillowAdvisories', JSON.stringify(advisoriesFor('Pillow').map((a) => ({ lt: a.lt, sev: a.severity }))));;
    console.log('isVuln axios 0.19 per advisory', advisoriesFor('axios').map((a) => isVulnerable('^0.19.0', a)));
    console.log('isVuln axios 1.8 per advisory', advisoriesFor('axios').map((a) => isVulnerable('^1.8.0', a)));
    console.log('isVuln lodash 4.17.22', isVulnerable('^4.17.22', advisoriesFor('lodash')[0]));
    console.log('isVuln Pillow 8.0.0', isVulnerable('>=8.0.0', advisoriesFor('Pillow')[0]));
    expect(true).toBe(true);
  });
});