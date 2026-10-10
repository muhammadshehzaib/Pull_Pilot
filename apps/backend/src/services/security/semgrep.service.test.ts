import { describe, it, expect, vi } from 'vitest';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { runSemgrep, type SemgrepRunner } from './semgrep.service';

const VALID_OUTPUT = JSON.stringify({
  results: [
    {
      check_id: 'javascript.lang.security.audit.sqli',
      path: 'src/app.js',
      start: { line: 12 },
      extra: { message: 'Possible SQL injection', metadata: { severity: 'HIGH' } },
    },
    {
      check_id: 'generic.secrets.hardcoded',
      path: './src/keys.ts',
      start: { line: 3 },
      extra: { severity: 'ERROR' },
    },
  ],
});

function runnerReturning(stdout: string, missing = false): SemgrepRunner {
  return async () => ({ stdout, stderr: '', exitCode: missing ? -1 : 0, missing });
}

async function collectFiles(root: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await collectFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

describe('runSemgrep', () => {
  it('normalises Semgrep results into SAST findings', async () => {
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: runnerReturning(VALID_OUTPUT),
    });

    expect(result.degraded).toBe(false);
    expect(result.findings).toHaveLength(2);

    const sqli = result.findings.find((f) => f.ruleKey.includes('sqli'))!;
    expect(sqli.filePath).toBe('src/app.js');
    expect(sqli.lineNumber).toBe(12);
    expect(sqli.priority).toBe('HIGH');
    expect(sqli.source).toBe('SAST');
    expect(sqli.agentType).toBe('SECURITY');
    expect(sqli.issue).toContain('Possible SQL injection');

    const generic = result.findings.find((f) => f.ruleKey.includes('hardcoded'))!;
    // A leading "./" is stripped and ERROR maps to HIGH.
    expect(generic.filePath).toBe('src/keys.ts');
    expect(generic.priority).toBe('HIGH');
  });

  it('reports a degraded run when the binary is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: runnerReturning('', true),
    });
    expect(result.findings).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('binary not found');
    log.mockRestore();
  });

  it('reports a degraded run for unparsable output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: runnerReturning('not json at all'),
    });
    expect(result.findings).toEqual([]);
    expect(result.degraded).toBe(true);
    warn.mockRestore();
  });

  it('recovers JSON printed after a banner', async () => {
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: runnerReturning(`Scanning...\n${VALID_OUTPUT}\nDone.`),
    });
    expect(result.findings).toHaveLength(2);
  });

  it('returns a clean, non-degraded result for a clean run', async () => {
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: runnerReturning('{"results":[]}'),
    });
    expect(result.findings).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it('reports a degraded run when there are no files to scan', async () => {
    const result = await runSemgrep({ files: new Map(), runner: runnerReturning(VALID_OUTPUT) });
    expect(result.findings).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('no scannable');
  });

  it('refuses to materialise unsafe paths', async () => {
    let written: string[] = [];
    const runner: SemgrepRunner = async (_args, cwd) => {
      written = await collectFiles(cwd);
      return { stdout: '{"results":[]}', stderr: '', exitCode: 0 };
    };

    await runSemgrep({
      files: new Map([
        ['src/ok.js', 'ok'],
        ['../escape.js', 'malicious'],
        ['/etc/passwd', 'malicious'],
      ]),
      runner,
    });

    expect(written).toEqual(['src/ok.js']);
  });

  it('writes file contents into the scan directory', async () => {
    let seen: string | null = null;
    const runner: SemgrepRunner = async (_args, cwd) => {
      seen = await readFile(join(cwd, 'src/app.js'), 'utf8');
      return { stdout: '{"results":[]}', stderr: '', exitCode: 0 };
    };

    await runSemgrep({
      files: new Map([['src/app.js', 'const secret = 42;']]),
      runner,
    });

    expect(seen).toBe('const secret = 42;');
  });

  it('reports a degraded run when the runner throws instead of failing the review', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runSemgrep({
      files: new Map([['src/app.js', 'const x = 1;']]),
      runner: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('spawn failed');
    warn.mockRestore();
  });
});