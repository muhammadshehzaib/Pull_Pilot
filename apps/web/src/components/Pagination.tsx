'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface PaginationProps {
  /** 1-based current page, as returned by the API's `pagination.page`. */
  page: number;
  totalPages: number;
  /** Total rows across all pages; shown next to the page indicator when given. */
  total?: number;
  /** Plural noun for the count, e.g. "reviews". */
  noun?: string;
  onChange: (page: number) => void;
  /** Keeps the buttons disabled while a page load is in flight. */
  busy?: boolean;
}

/**
 * Offset pagination controls: Prev / "Page X of Y" / Next.
 *
 * Renders nothing when everything fits on one page — a control that cannot do
 * anything is noise. Page numbers are not offered as a list because neither
 * endpoint returns the pages that exist, only `totalPages`; Prev/Next plus the
 * page indicator is what the data can honestly support.
 */
export function Pagination({
  page,
  totalPages,
  total,
  noun,
  onChange,
  busy = false,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <nav
      className="pagination-bar"
      aria-label="Pagination"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        marginTop: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onChange(page - 1)}
        disabled={atStart || busy}
        aria-label="Previous page"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        <ChevronLeft size={14} /> Prev
      </button>

      <span
        aria-live="polite"
        style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}
      >
        Page {page} of {totalPages}
        {typeof total === 'number' && noun ? ` · ${total} ${noun}` : ''}
      </span>

      <button
        type="button"
        className="btn-secondary"
        onClick={() => onChange(page + 1)}
        disabled={atEnd || busy}
        aria-label="Next page"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        Next <ChevronRight size={14} />
      </button>
    </nav>
  );
}
