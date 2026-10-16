import type { FindingSeverity } from '../ai/finding-taxonomy';
import { OSV_API_URL, OSV_MAX_BATCH, OSV_QUERY_TIMEOUT_MS } from '../../utils/constants';
import { isRecord, osvSeverity } from './osv-severity';
export { osvSeverity } from './osv-severity';

export interface OsvPackageRef { name: string; version: string; ecosystem: string }
export interface OsvVulnerability {
  id: string; summary: string; severity: FindingSeverity; severityKnown: boolean; aliases: string[];
}
export interface OsvQueryResult {
  ref: OsvPackageRef; vulnerabilities: OsvVulnerability[];
  /** False when pages, details or severity were unavailable. */
  complete: boolean;
}
export interface OsvQueryOutcome { results: OsvQueryResult[]; degraded: boolean }
export interface OsvBatchRequest {
  queries: Array<{ package: { name: string; ecosystem: string }; version: string; page_token?: string }>;
}
/** The real bulk API returns IDs/modified dates, not full advisory records. */
export interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string; modified?: string }>; next_page_token?: string }>;
}
export type OsvTransport = (endpoint: string, body: OsvBatchRequest, signal: AbortSignal) => Promise<OsvBatchResponse>;
export type OsvDetailTransport = (endpoint: string, signal: AbortSignal) => Promise<unknown>;
export interface OsvClientOptions {
  endpoint?: string; transport?: OsvTransport; detailTransport?: OsvDetailTransport;
  timeoutMs?: number; budgetMs?: number; maxBatch?: number;
}
export const DEFAULT_MAX_BATCH = 200;
export const OSV_LIMITS = { refs: 500, batches: 10, pages: 3, ids: 500, details: 200,
  concurrency: 6, timeoutMs: 8000, budgetMs: 20000, responseBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 } as const;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const bounded = (value: number | undefined, fallback: number, max: number) =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;

type RefState = { ref: OsvPackageRef; ids: Set<string>; complete: boolean; pages: number; token?: string; tokens: Set<string> };

/** Batched discovery followed by bounded, deduplicated full-advisory lookups. */
export class OsvClient {
  private readonly endpoint: string;
  private readonly detailBase: string;
  private readonly transport?: OsvTransport;
  private readonly detailTransport?: OsvDetailTransport;
  private readonly timeoutMs: number;
  private readonly budgetMs: number;
  private readonly maxBatch: number;

  constructor(options: OsvClientOptions = {}) {
    this.endpoint = options.endpoint ?? `${OSV_API_URL}/v1/querybatch`;
    this.detailBase = new URL('./vulns/', this.endpoint).href;
    this.transport = options.transport;
    this.detailTransport = options.detailTransport;
    this.timeoutMs = bounded(options.timeoutMs ?? OSV_QUERY_TIMEOUT_MS, OSV_LIMITS.timeoutMs, OSV_LIMITS.timeoutMs);
    this.budgetMs = bounded(options.budgetMs, OSV_LIMITS.budgetMs, OSV_LIMITS.budgetMs);
    this.maxBatch = bounded(options.maxBatch ?? OSV_MAX_BATCH, DEFAULT_MAX_BATCH, DEFAULT_MAX_BATCH);
  }

  /** Failures reduce coverage; they never erase already-discovered advisories. */
  async query(refs: OsvPackageRef[], signal?: AbortSignal): Promise<OsvQueryOutcome> {
    const unique = dedupeRefs(refs);
    const states: RefState[] = unique.slice(0, OSV_LIMITS.refs).map(ref =>
      ({ ref, ids: new Set(), complete: true, pages: 0, tokens: new Set() }));
    if (!states.length) return { results: [], degraded: false };
    let degraded = unique.length > states.length;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, this.budgetMs);
    const call = <T>(operation: (signal: AbortSignal) => Promise<T>) =>
      boundedCall(controller.signal, this.timeoutMs, operation);
    const bytes = { remaining: OSV_LIMITS.totalBytes as number };
    const batchTransport: OsvTransport = this.transport ?? ((endpoint, body, child) => httpTransport(endpoint, body, child, bytes));
    const detailTransport: OsvDetailTransport = this.detailTransport ?? ((endpoint, child) => httpDetailTransport(endpoint, child, bytes));
    try {
      const pending = [...states], ids = new Set<string>();
      let requests = 0;
      while (pending.length && !controller.signal.aborted && requests < OSV_LIMITS.batches) {
        const slice = pending.splice(0, this.maxBatch);
        requests++;
        try {
          const response = await call(child => batchTransport(this.endpoint, { queries: slice.map(state => ({
            package: { name: state.ref.name, ecosystem: state.ref.ecosystem }, version: state.ref.version,
            ...(state.token ? { page_token: state.token } : {}),
          })) }, child));
          if (!isRecord(response) || !Array.isArray(response.results) || response.results.length > slice.length) throw new Error('Invalid OSV batch');
          const batchResults = response.results;
          slice.forEach((state, index) => {
            state.pages++;
            const result = batchResults[index];
            if (!isRecord(result) || (result.vulns !== undefined && !Array.isArray(result.vulns))) {
              state.complete = false; return;
            }
            for (const raw of result.vulns ?? []) {
              if (!isRecord(raw) || !validId(raw.id)) { state.complete = false; continue; }
              if (!ids.has(raw.id) && ids.size >= OSV_LIMITS.ids) { state.complete = false; continue; }
              ids.add(raw.id); state.ids.add(raw.id);
            }
            const token = result.next_page_token;
            if (token !== undefined && token !== '') {
              if (typeof token !== 'string' || token.length > 4096 || state.tokens.has(token) || state.pages >= OSV_LIMITS.pages) {
                state.complete = false; return;
              }
              state.tokens.add(token); state.token = token; pending.push(state);
            }
          });
        } catch {
          for (const state of slice) state.complete = false;
        }
      }
      for (const state of pending) state.complete = false;

      // This cache is local to this lookup. A shared advisory costs one GET,
      // even if several packages/versions refer to it.
      const records = new Map<string, Record<string, unknown>>();
      const detailIds = [...ids].slice(0, OSV_LIMITS.details);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(OSV_LIMITS.concurrency, detailIds.length) }, async () => {
        while (cursor < detailIds.length && !controller.signal.aborted) {
          const id = detailIds[cursor++]!;
          try {
            const raw = await call(child => detailTransport(this.detailBase + encodeURIComponent(id), child));
            if (isRecord(raw) && raw.id === id) records.set(id, raw);
          } catch { /* Keep the ID; the finding will require manual review. */ }
        }
      }));

      const severityCache = new Map<string, FindingSeverity | null>();
      const results = states.map(state => {
        const vulnerabilities: OsvVulnerability[] = [];
        for (const id of state.ids) {
          const record = records.get(id);
          if (typeof record?.withdrawn === 'string' && record.withdrawn.trim()) continue;
          // OSV IDs are case-sensitive even when package matching is normalized.
          const severityKey = JSON.stringify([id, state.ref.ecosystem.toLowerCase(), state.ref.name.toLowerCase()]);
          if (!severityCache.has(severityKey)) severityCache.set(severityKey, osvSeverity(record, state.ref));
          const severity = severityCache.get(severityKey)!;
          if (!record || severity === null) state.complete = false;
          const summary = record && (typeof record.summary === 'string' && record.summary.trim() ||
            typeof record.details === 'string' && record.details.trim().split('\n', 1)[0]);
          vulnerabilities.push({ id, summary: summary ? summary.slice(0, 200) : 'Known vulnerability with no summary provided.',
            severity: severity ?? 'HIGH', severityKnown: severity !== null,
            aliases: Array.isArray(record?.aliases) ? record.aliases.filter((alias): alias is string => typeof alias === 'string').slice(0, 50) : [] });
        }
        return { ref: state.ref, vulnerabilities, complete: state.complete };
      });
      degraded ||= results.some(result => !result.complete);
      if (degraded) console.warn('OSV lookup incomplete; some advisory details or severities are unavailable. Manual review may be required.');
      return { results, degraded };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}

function dedupeRefs(refs: OsvPackageRef[]): OsvPackageRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.ecosystem}\u0000${ref.name}\u0000${ref.version}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Also stops injected/noncooperative transports when their deadline expires. */
async function boundedCall<T>(parent: AbortSignal, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent.addEventListener('abort', cancel, { once: true });
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('OSV request stopped'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (parent.aborted) throw new Error('OSV request stopped');
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function responseJson(response: Response, bytes: { remaining: number }): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > OSV_LIMITS.responseBytes || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('OSV response unavailable');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      bytes.remaining -= value.length;
      if (size > OSV_LIMITS.responseBytes || bytes.remaining < 0) throw new Error('OSV response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function httpTransport(endpoint: string, body: OsvBatchRequest, signal: AbortSignal, bytes: { remaining: number }): Promise<OsvBatchResponse> {
  if (bytes.remaining <= 0) throw new Error('OSV response budget exhausted');
  return await responseJson(await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal, redirect: 'error' }), bytes) as OsvBatchResponse;
}
async function httpDetailTransport(endpoint: string, signal: AbortSignal, bytes: { remaining: number }): Promise<unknown> {
  if (bytes.remaining <= 0) throw new Error('OSV response budget exhausted');
  return responseJson(await fetch(endpoint, { signal, redirect: 'error' }), bytes);
}
