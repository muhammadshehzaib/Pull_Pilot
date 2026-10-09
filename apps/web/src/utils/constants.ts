/**
 * Application-wide constants.
 *
 * Mirrors apps/backend/src/utils/constants.ts: configuration that describes how
 * the app runs rather than what it renders. Domain vocabulary — review statuses,
 * severity scales, agent labels — stays in lib/review.ts, which is already the
 * shared, tested source for it.
 *
 * NEXT_PUBLIC_* INLINING
 * Next.js replaces literal `process.env.NEXT_PUBLIC_*` references with
 * hard-coded values at build time. The replacement is per-reference, not
 * per-file, so these still inline correctly from this module. What would NOT be
 * inlined is a dynamic lookup — `process.env[name]` or destructuring
 * `const { NEXT_PUBLIC_X } = process.env` — so the full literal form is used
 * deliberately below and should not be "tidied up".
 *
 * These are therefore frozen at build time, not read at request time.
 */
export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

export const GITHUB_APP_INSTALL_URL =
  `${BACKEND_URL}/api/auth/github-app/install`;
