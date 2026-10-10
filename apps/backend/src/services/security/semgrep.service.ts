import { execFile } from 'child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve as resolvePath, dirname } from 'path';
import { normalizeSeverity, type FindingSeverity } from '../ai/finding-taxonomy';
import { SecuritySuggestion, MAX_FINDINGS_PER_RULE } from './probe-types';
import { SEMGREP_BIN, SEMGREP_RULES, SEMGREP_TIMEOUT_MS } from '../../utils/constants';

/**
 * Semgrep adapter — an *optional* second SAST pass on top of the built-in
 * regex rules.
 *
 * Semgrep is a mature, community-maintained static-analysis engine. Rather
 * than try to reproduce its breadth of rules, we shell out to it when the
 * binary is available and fold its findings into the same SAST probe. When the
 * binary is absent, or the run fails, the pass is skipped and the built-in
 * rules still run — an external scanner must never be able to fail a review.
 *
 * Files to scan come from the caller (the worker fetches the changed files'
 * full contents from GitHub); Semgrep needs whole files, not diff hunks. They
 * are written to a throwaway temp directory, scanned there, and deleted.
 */

export interface SemgrepExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the binary could not be spawned (not installed / not on PATH). */
  missing?: boolean;
}

/** Runs the semgrep binary. Injectable so tests never spawn a real process. */
export type SemgrepRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<SemgrepExecResult>;

export interface SemgrepOptions {
  /** Repo-relative path -> full file content. */
  files: Map<string, string>;
  bin?: string;
  rules?: string;
  timeoutMs?: number;
  runner?: SemgrepRunner;
}

/** Semgrep JSON output, narrowed to the fields we consume. */
interface SemgrepJson {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number };
    extra?: {
      message?: string;
      severity?: string;
      metadata?: { severity?: string; description?: string };
    };
  }>;
}

const MAX_FILES = 60;
const MAX_FILE_BYTES = 200_000;

/**
 * Outcome of one Semgrep pass. Unlike the old optional-`null` contract this
 * tells the caller *why* nothing was produced, so the SAST probe can truthfully
 * report DEGRADED instead of pretending the extra pass ran.
 */
export interface SemgrepRun {
  findings: SecuritySuggestion[];
  /** True when the extra pass did not actually run (missing binary, unusable
   *  output, no scannable files) — coverage was reduced, not clean. */
  degraded: boolean;
  /** Human-readable reason for a degraded run, for the probe's detail field. */
  reason?: string;
}

/**
 * Runs Semgrep over the supplied changed files.
 *
 * Findings are normalized into `SecuritySuggestion`. A `degraded: true` result
 * means Semgrep did not run to completion (binary missing, unparsable output,
 * no files, or a crash); the caller keeps the built-in SAST results either way,
 * but must not report the optional pass as a successful scan.
 */
export async function runSemgrep(options: SemgrepOptions): Promise<SemgrepRun> {
  const files = selectScannableFiles(options.files);
  if (files.length === 0) {
    return { findings: [], degraded: true, reason: 'no scannable changed files' };
  }

  const bin = options.bin ?? SEMGREP_BIN;
  const rules = options.rules ?? SEMGREP_RULES;
  const timeoutMs = options.timeoutMs ?? SEMGREP_TIMEOUT_MS;
  const runner = options.runner ?? defaultRunner(bin);

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'aipr-semgrep-'));

    for (const [path, content] of files) {
      const target = safeJoin(dir, path);
      if (!target) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }

    // `--metrics=off` keeps source paths off Semgrep's telemetry. Exit code 1
    // simply means "findings found", so only a missing binary or unparsable
    // output is treated as a degraded run.
    const exec = await runner(
      ['--json', '--quiet', '--metrics=off', '--config', rules, '.'],
      dir,
      timeoutMs,
    );

    if (exec.missing) {
      console.log('ℹ️  Semgrep not found on PATH; skipping the extra SAST pass.');
      return { findings: [], degraded: true, reason: 'semgrep binary not found (install it or disable security.semgrep)' };
    }

    const parsed = parseSemgrepJson(exec.stdout);
    if (!parsed) {
      if (exec.stderr.trim()) {
        console.warn(`⚠️ Semgrep produced no usable output: ${exec.stderr.trim().slice(0, 300)}`);
      }
      return {
        findings: [],
        degraded: true,
        reason: exec.stderr.trim()
          ? `semgrep produced no usable output (${exec.stderr.trim().slice(0, 120)})`
          : 'semgrep produced no usable output',
      };
    }

    return { findings: toFindings(parsed), degraded: false };
  } catch (error) {
    console.warn(`⚠️ Semgrep pass failed (${(error as Error).message}); continuing with built-in SAST only.`);
    return {
      findings: [],
      degraded: true,
      reason: `semgrep pass failed: ${(error as Error).message}`,
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keeps only source-sized files we can safely scan. */
function selectScannableFiles(files: Map<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, content] of files) {
    if (out.length >= MAX_FILES) break;
    if (content.length === 0 || content.length > MAX_FILE_BYTES) continue;
    if (!isSafeRelativePath(path)) continue;
    out.push([path, content]);
  }
  return out;
}

/** True for a repo-relative path with no absolute prefix and no `..` escape. */
function isSafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

/** Joins a validated relative path under `root`; returns null when unsafe. */
function safeJoin(root: string, path: string): string | null {
  if (!isSafeRelativePath(path)) return null;
  return resolvePath(root, path.replace(/\\/g, '/'));
}

function parseSemgrepJson(stdout: string): SemgrepJson | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as SemgrepJson;
  } catch {
    // Semgrep occasionally prints a banner before the JSON object; recover the
    // outermost object rather than discarding an otherwise valid run.
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as SemgrepJson;
    } catch {
      return null;
    }
  }
}

function toFindings(parsed: SemgrepJson): SecuritySuggestion[] {
  const findings: SecuritySuggestion[] = [];
  const counts = new Map<string, number>();

  for (const result of parsed.results ?? []) {
    const filePath = normalizeResultPath(result.path ?? '');
    const line = Number.isFinite(result.start?.line) ? Number(result.start!.line) : 1;
    const checkId = result.check_id ?? 'semgrep';
    const ruleKey = `semgrep:${checkId}`;

    const n = counts.get(ruleKey) ?? 0;
    if (n >= MAX_FINDINGS_PER_RULE) continue;
    counts.set(ruleKey, n + 1);

    const message =
      result.extra?.metadata?.description ||
      result.extra?.message ||
      `Semgrep rule ${checkId} matched.`;

    findings.push({
      filePath,
      lineNumber: line,
      agentType: 'SECURITY',
      source: 'SAST',
      ruleKey,
      issue: `${checkId} — ${truncate(message, 200)}`,
      suggestion: 'Review the matched pattern and apply the guidance for this Semgrep rule.',
      priority: semgrepSeverity(result.extra),
    });
  }

  return findings;
}

/** Prefers the rule's own metadata severity, then Semgrep's coarse level. */
function semgrepSeverity(
  extra: { severity?: string; metadata?: { severity?: string } } | undefined,
): FindingSeverity {
  const fromMetadata = normalizeSeverity(extra?.metadata?.severity);
  if (fromMetadata) return fromMetadata;
  switch ((extra?.severity ?? '').toUpperCase()) {
    case 'ERROR':
      return 'HIGH';
    case 'WARNING':
      return 'MEDIUM';
    case 'INFO':
      return 'LOW';
    default:
      return 'MEDIUM';
  }
}

function normalizeResultPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** Default runner: spawn the binary, tolerating Semgrep's non-zero exit codes. */
function defaultRunner(bin: string): SemgrepRunner {
  return (args, cwd, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
          if (err && err.code === 'ENOENT') {
            resolve({ stdout: '', stderr: '', exitCode: -1, missing: true });
            return;
          }
          // A killed/timed-out process still resolves; the caller decides.
          const exitCode = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
        },
      );
    });
}