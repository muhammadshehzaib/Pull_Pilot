import { DEFAULT_LIMIT, MAX_LIMIT } from './constants';

/**
 * Offset pagination for list endpoints.
 *
 * Shared by every list controller so that "page" and "limit" mean the same
 * thing regardless of which resource is being paged: same clamping, same
 * fallbacks, same response shape. A client that learns the params on /jobs can
 * use them on /repositories unchanged.
 *
 * Offset (rather than cursor) pagination is deliberate: both lists are small,
 * user-scoped, and sorted by createdAt desc, so a `skip` is cheap and the UI
 * can offer page numbers and a total — which a cursor cannot.
 */

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Clamps `?limit=` to [1, MAX_LIMIT], falling back to DEFAULT_LIMIT for
 * missing, unparseable, or zero values (`parseInt('0') || default`).
 */
export function parseLimit(raw: unknown): number {
  const parsed = parseInt(String(raw ?? ''), 10) || DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

/**
 * Clamps `?page=` to a 1-based integer. Missing, unparseable, zero and
 * negative values all become page 1 — a bad page must degrade to the first
 * page, never to an empty result or a 400.
 */
export function parsePage(raw: unknown): number {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/** Parses both params together and derives the Prisma `skip`. */
export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const limit = parseLimit(query.limit);
  const page = parsePage(query.page);
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Builds the `pagination` object returned alongside every paged list.
 *
 * `totalPages` is at least 1 so an empty list still reads as "page 1 of 1"
 * rather than "page 1 of 0", which would make the UI's disabled-state math
 * disagree with itself.
 */
export function paginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
