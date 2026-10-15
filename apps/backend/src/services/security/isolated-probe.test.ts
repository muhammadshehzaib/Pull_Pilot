import { describe, expect, it } from 'vitest';
import { runIsolatedProbe } from './isolated-probe';

const diff = (line: string) => 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+' + line;

describe('actual isolated scanner threads', () => {
  it('runs SAST in a real thread and returns its finding without copying credentials', async () => {
    const result = await runIsolatedProbe('sast', diff('authorization: "Basic dXNlcjpwYXNzd29yZA=="'));
    expect(result.checks[0].status).toBe('FAIL');
    expect(result.findings[0].ruleKey).toBe('sast-basic-auth-literal');
    expect(JSON.stringify(result)).not.toContain('dXNlcjpwYXNzd29yZA==');
  }, 15000);
  it('runs secrets in a real thread with constant masking', async () => {
    const token = `ghp_${'C'.repeat(36)}`;
    const result = await runIsolatedProbe('secrets', diff(`// TOKEN = "${token}";`));
    expect(result.checks[0].status).toBe('FAIL');
    expect(result.findings[0].issue).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(token);
  }, 15000);
});
