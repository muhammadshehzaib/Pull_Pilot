import type { GitHubService } from './github.service';
import { CONTEXT_EXCLUDED_SEGMENTS, SCANNER_SOURCE_EXTENSIONS } from '../utils/constants';

/** How many file reads run at once. Keeps a cold repo off the rate limit. */
const FETCH_CONCURRENCY = 6;

/** Hard cap on files fetched for a local scanner pass. */
export const MAX_SCANNER_FILES = 60;

/**
 * Fetches the full content of changed source files so an external scanner can
 * analyse them.
 *
 * A git diff only carries hunks, but Semgrep needs whole files to parse and
 * match rules, so this reads each changed source file at the head revision.
 * Only recognisable source extensions are fetched — there is no point spending
 * an API call on a PNG — and failures are swallowed per file: a scan over fewer
 * files is still a useful scan.
 */
export async function fetchChangedFileContents(
  ghService: GitHubService,
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
): Promise<Map<string, string>> {
  const targets = paths.filter(isScannablePath).slice(0, MAX_SCANNER_FILES);
  const contents = new Map<string, string>();

  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const slice = targets.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (path) => ({
        path,
        content: await ghService.getFileContent(owner, repo, path, ref).catch(() => null),
      })),
    );
    for (const result of results) {
      if (result.content) contents.set(result.path, result.content);
    }
  }

  return contents;
}

/** True for a repo path worth handing to a source scanner. */
export function isScannablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/')) return false;

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return false;
  if (segments.some((segment) => CONTEXT_EXCLUDED_SEGMENTS.has(segment))) return false;

  const dot = normalized.lastIndexOf('.');
  if (dot === -1) return false;
  return SCANNER_SOURCE_EXTENSIONS.has(normalized.slice(dot).toLowerCase());
}