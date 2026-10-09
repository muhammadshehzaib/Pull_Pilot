import { normalizeSeverity, type FindingSeverity } from '../ai/finding-taxonomy';
import { OSV_API_URL, OSV_MAX_BATCH, OSV_QUERY_TIMEOUT_MS } from '../../utils/constants';

/**
 * OSV.dev client — the dependency probe's connection to a real, live advisory
 * database instead of a hand-maintained list.
 *
 * OSV (https://osv.dev) aggregates advisories from GitHub, PyPA, Go, RustSec
 * and the OSV database itself and exposes them over a simple JSON API. We use
 * the batch endpoint so a manifest with twenty changed dependencies costs one
 * request rather than twenty.
 *
 * The whole client is designed to be optional and non-fatal: a network failure
 * must never fail a review. `query()` reports `degraded: true` instead of
 * throwing, which lets the caller fall back to the bundled offline registry.
 * Every external call carries a timeout, and the transport is injectable so the
 * probe can be tested without a network.
 */

/** One package+version to look up, with the OSV ecosystem name. */
export interface OsvPackageRef {
  name: string;
  version: string;
  ecosystem: string;
}

/** A vulnerability as the probe consumes it — normalised, not raw OSV JSON. */
export interface OsvVulnerability {
  id: string;
  summary: string;
  severity: FindingSeverity;
  aliases: string[];
}

export interface OsvQueryResult {
  ref: OsvPackageRef;
  vulnerabilities: OsvVulnerability[];
}

export interface OsvQueryOutcome {
  results: OsvQueryResult[];
  /** True when at least one batch failed; the results are partial and the
   *  caller should treat the offline registry as the source of truth. */
  degraded: boolean;
}

export interface OsvBatchRequest {
  queries: Array<{ package: { name: string; ecosystem: string }; version: string }>;
}

export interface OsvBatchResponse {
  results?: Array<{ vulns?: OsvVulnJson[] }>;
}

interface OsvVulnJson {
  id?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: {
    severity?: string;
    cvss_score?: number | string;
  };
  ecosystem_specific?: {
    severity?: string;
  };
}

/** Performs the HTTP call. Injectable so tests never touch the network. */
export type OsvTransport = (
  endpoint: string,
  body: OsvBatchRequest,
  signal: AbortSignal,
) => Promise<OsvBatchResponse>;

export interface OsvClientOptions {
  endpoint?: string;
  transport?: OsvTransport;
  timeoutMs?: number;
  /** Queries per HTTP request. OSV allows up to 1000; we keep well under that. */
  maxBatch?: number;
}

/** Max distinct packages per OSV batch request. */
export const DEFAULT_MAX_BATCH = 200;

export class OsvClient {
  private readonly endpoint: string;
  private readonly transport: OsvTransport;
  private readonly timeoutMs: number;
  private readonly maxBatch: number;

  constructor(options: OsvClientOptions = {}) {
    this.endpoint = options.endpoint ?? `${OSV_API_URL}/v1/querybatch`;
    this.transport = options.transport ?? httpTransport;
    this.timeoutMs = options.timeoutMs ?? OSV_QUERY_TIMEOUT_MS;
    this.maxBatch = options.maxBatch ?? (OSV_MAX_BATCH || DEFAULT_MAX_BATCH);
  }

  /**
   * Looks up many packages at once. Never throws: a failed batch is reported
   * through `degraded` so the dependency probe can fall back to its offline
   * registry rather than losing the whole scan.
   */
  async query(refs: OsvPackageRef[]): Promise<OsvQueryOutcome> {
    const unique = dedupeRefs(refs);
    const results: OsvQueryResult[] = [];
    if (unique.length === 0) return { results, degraded: false };

    let degraded = false;

    for (let i = 0; i < unique.length; i += this.maxBatch) {
      const slice = unique.slice(i, i + this.maxBatch);
      const body: OsvBatchRequest = {
        queries: slice.map((ref) => ({
          package: { name: ref.name, ecosystem: ref.ecosystem },
          version: ref.version,
        })),
      };

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: OsvBatchResponse;
        try {
          response = await this.transport(this.endpoint, body, controller.signal);
        } finally {
          clearTimeout(timer);
        }

        const batchResults = response.results ?? [];
        slice.forEach((ref, index) => {
          const vulns = batchResults[index]?.vulns ?? [];
          results.push({ ref, vulnerabilities: vulns.map(toVulnerability).filter(isUsable) });
        });
      } catch (error) {
        console.warn(
          `⚠️ OSV query failed (${(error as Error).message}); falling back to the bundled advisory registry.`,
        );
        degraded = true;
      }
    }

    return { results, degraded };
  }
}

/** Drops duplicate (ecosystem, name, version) tuples. */
function dedupeRefs(refs: OsvPackageRef[]): OsvPackageRef[] {
  const seen = new Set<string>();
  const out: OsvPackageRef[] = [];
  for (const ref of refs) {
    const key = `${ref.ecosystem}\u0000${ref.name}\u0000${ref.version}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function toVulnerability(raw: OsvVulnJson): OsvVulnerability {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'OSV-UNKNOWN';
  const summary =
    (typeof raw.summary === 'string' && raw.summary.trim()) ||
    (typeof raw.details === 'string' && raw.details.trim().split('\n')[0]) ||
    'Known vulnerability with no summary provided.';
  return {
    id,
    summary: summary.length > 200 ? `${summary.slice(0, 197)}...` : summary,
    severity: osvSeverity(raw),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === 'string') : [],
  };
}

/** A record without an id is not actionable; drop it rather than guess. */
function isUsable(v: OsvVulnerability): boolean {
  return v.id !== 'OSV-UNKNOWN';
}

/**
 * Best-effort severity extraction from an OSV record.
 *
 * OSV does not mandate a single severity field, so this walks the common
 * locations in order of reliability: the GitHub-style `database_specific`
 * severity, then `ecosystem_specific`, then a numeric CVSS score, and finally a
 * CVSS vector string. An unknown record is treated as MEDIUM — visible and
 * actionable, but never allowed to inflate the risk verdict to BLOCK on its own.
 */
export function osvSeverity(raw: OsvVulnJson): FindingSeverity {
  const db = raw.database_specific?.severity;
  const normalizedDb = normalizeSeverity(db);
  if (normalizedDb) return normalizedDb;

  const eco = normalizeSeverity(raw.ecosystem_specific?.severity);
  if (eco) return eco;

  const score = numericScore(raw.database_specific?.cvss_score);
  if (score !== null) return severityFromScore(score);

  for (const entry of raw.severity ?? []) {
    const parsed = numericScore(entry.score);
    if (parsed !== null) return severityFromScore(parsed);
  }

  return 'MEDIUM';
}

function numericScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function severityFromScore(score: number): FindingSeverity {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'MEDIUM';
}

/** Default transport: one POST to the OSV batch endpoint. */
async function httpTransport(
  endpoint: string,
  body: OsvBatchRequest,
  signal: AbortSignal,
): Promise<OsvBatchResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OSV responded ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as OsvBatchResponse;
}