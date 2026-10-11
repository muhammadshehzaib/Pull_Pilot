const REASONS: Record<string, string> = {
  TREE_UNAVAILABLE: 'The repository file list was unavailable.', TREE_TRUNCATED: 'The repository file list was incomplete.',
  FILE_LIMIT: 'The repository exceeded the discovery file limit.', DOWNLOAD_LIMIT: 'Discovery reached its download limit.',
  BYTE_LIMIT: 'Discovery reached its download size limit.', DEADLINE: 'Discovery reached its time limit.',
  FILE_UNAVAILABLE: 'Some source files could not be read.', UNSUPPORTED_RESOLUTION: 'Some import patterns or project settings are not supported.',
  MISSING_CHANGED_FILE: 'Some changed files were deleted or unavailable for impact analysis.', CONTENT_UNAVAILABLE: 'Some selected background files could not be read.',
  CACHE_UNAVAILABLE: 'Some cached relationships could not be read or saved.', OVERSIZED_FILE: 'Some files were too large to inspect.',
  UNRESOLVED_IMPORT: 'Some local imports could not be resolved.',
};

/** Unknown and legacy records must not turn into a complete-coverage claim. */
export function ContextDiscoveryCard({ report }: { report: unknown }) {
  if (!report || typeof report !== 'object') return null;
  const data = report as Record<string, unknown>;
  if (data.version !== 1 || !['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(String(data.status))
    || !['indexedFiles', 'eligibleFiles', 'selectedFiles'].every(key => Number.isSafeInteger(data[key]) && Number(data[key]) >= 0)
    || !Array.isArray(data.reasons) || !data.reasons.every(reason => typeof reason === 'string')) return null;
  const status = data.status === 'COMPLETE' ? 'Complete within supported scope' : data.status === 'PARTIAL' ? 'Partial' : 'Unavailable';
  return <section aria-label="Repository context" style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' }}>
    <strong>Repository context: {status}</strong>
    {data.status !== 'UNAVAILABLE' && <p>{String(data.indexedFiles)} of {String(data.eligibleFiles)} eligible source files checked; {String(data.selectedFiles)} background files selected.</p>}
    <p>Import relationships help identify affected files. They do not prove function calls, test coverage, or that a change is safe.</p>
    {data.reasons.length > 0 && <ul>{[...new Set(data.reasons as string[])].map(reason => <li key={reason}>{REASONS[reason] ?? 'Some relationship evidence was unavailable.'}</li>)}</ul>}
  </section>;
}
