export type DiscoveryReason = 'TREE_UNAVAILABLE' | 'TREE_TRUNCATED' | 'FILE_LIMIT'
  | 'DOWNLOAD_LIMIT' | 'BYTE_LIMIT' | 'DEADLINE' | 'FILE_UNAVAILABLE'
  | 'UNSUPPORTED_RESOLUTION' | 'MISSING_CHANGED_FILE' | 'CONTENT_UNAVAILABLE'
  | 'CACHE_UNAVAILABLE' | 'OVERSIZED_FILE' | 'UNRESOLVED_IMPORT';

/** COMPLETE is scoped to eligible JS/TS files and supported static resolution. */
export interface ContextDiscovery {
  version: 1;
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  headSha: string;
  eligibleFiles: number;
  indexedFiles: number;
  missingFiles: number;
  selectedFiles: number;
  importCacheHits: number;
  sourceCacheHits: number;
  downloads: number;
  downloadedBytes: number;
  elapsedMs: number;
  reasons: DiscoveryReason[];
}

/** Race cache operations too: a stalled DB must not consume the review budget. */
export async function withContextSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  operation.catch(() => {});
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Context discovery aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
