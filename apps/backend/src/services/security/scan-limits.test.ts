import { describe, expect, it } from 'vitest';
import { scanSast } from './probes/sast';
import { scanSecrets } from './probes/secrets';
import { boundScanInput, MAX_SCAN_DIFF_CHARS, MAX_SCAN_LINE_CHARS, MAX_SCAN_LINES } from './scan-input';
import { runBoundedWorker } from './bounded-worker';
import { assessExplainableRisk } from './risk-engine';

const diff = (lines: string[]) => ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', ...lines.map(line => '+' + line)].join('\n');

describe('bounded scanner inputs and execution', () => {
  it('omits very long lines without inventing clean coverage or shifting findings', () => {
    const raw = diff(['a'.repeat(500000), `const TOKEN = "ghp_${'C'.repeat(36)}";`]);
    const result = scanSecrets(raw);
    expect(result.findings[0]).toMatchObject({ filePath: 'src/a.ts', lineNumber: 2, redacted: true });
    expect(result.checks[0]).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('not checked') });
    const risk = assessExplainableRisk(result.findings, { securityChecks: result.checks });
    expect(risk.coverage.security.SECRETS).toBe('PARTIAL');
  });
  it('marks SAST incomplete when oversized lines contain otherwise suspicious content', () => {
    const result = scanSast(diff(['authorization: "Basic ' + 'A'.repeat(MAX_SCAN_LINE_CHARS * 100) + '"']));
    expect(result.findings).toEqual([]);
    expect(result.checks[0]).toMatchObject({ status: 'DEGRADED', detail: expect.stringContaining('not checked') });
  });
  it('bounds total diff size and physical lines without preserving partial source lines', () => {
    const result = boundScanInput(diff(['a'.repeat(MAX_SCAN_DIFF_CHARS * 2)]));
    expect(result.incomplete).toBe(true);
    expect(result.diff.length).toBeLessThanOrEqual(MAX_SCAN_DIFF_CHARS);
    expect(boundScanInput(diff(Array.from({ length: MAX_SCAN_LINES + 1 }, () => 'x'))).incomplete).toBe(true);
  });
  it('terminates an actual hung thread while the parent event loop stays responsive', async () => {
    let responsive = false;
    const pending = runBoundedWorker('while (true) {}', null, 150);
    setImmediate(() => { responsive = true; });
    await expect(pending).rejects.toThrow('Scanner execution limit exceeded');
    expect(responsive).toBe(true);
  });
  it('fails closed when a thread exits without completing its scan', async () => {
    await expect(runBoundedWorker('process.exit(0)', null, 1000)).rejects.toThrow('Scanner stopped without a result');
  });
});
