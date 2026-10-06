import { AiProvider } from '@prisma/client';

/**
 * Application-wide constants.
 *
 * This module holds configuration that describes *how the service runs* rather
 * than what it computes: service URLs, infrastructure endpoints, retention
 * windows, tuning limits and provider credentials-adjacent defaults.
 *
 * Two rules govern what belongs here:
 *
 *  1. Infrastructure and configuration only. Domain vocabulary — review
 *     lifecycle statuses, finding categories, severity scales — stays with the
 *     domain module that owns it (workers/job-state.ts,
 *     services/ai/finding-taxonomy.ts, and so on). Centralising those would split
 *     a single concept across two files and make the vocabulary harder, not
 *     easier, to change.
 *  2. Single definition. Anything that was duplicated now has one home. In
 *     particular JOB_RETENTION_DAYS was previously parsed twice (config/queue.ts
 *     and workers/job-retention.ts) from the same env var, so the BullMQ
 *     retention window and the database sweep could silently disagree.
 *
 * ENVIRONMENT TIMING
 * These are read once, at module load. That is intentional and unchanged from
 * the inline constants they replace. Every consumer of this module is reached
 * through a dynamic `import()` in index.ts that runs *after* dotenv.config(), so
 * env is populated before these evaluate.
 *
 * PORT deliberately does NOT live here. index.ts calls dotenv.config() in its
 * module body, but ESM evaluates imports first — a static import of this file
 * would read PORT before dotenv had run and silently fall back to the default.
 */
export const PORT_DEFAULT = 4000;

/* -------------------------------------------------------------------------- */
/* Service URLs                                                               */
/* -------------------------------------------------------------------------- */

export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
export const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

/** GitHub's OAuth endpoints, used by the web login flow. */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';

/* -------------------------------------------------------------------------- */
/* Session cookie                                                            */
/* -------------------------------------------------------------------------- */

export const COOKIE_NAME = 'auth_token';

/** 7 days. */
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Redis                                                                      */
/* -------------------------------------------------------------------------- */

export const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

/* -------------------------------------------------------------------------- */
/* Analysis queue                                                             */
/* -------------------------------------------------------------------------- */

export const ANALYSIS_QUEUE_NAME = 'code-analysis-queue';

/**
 * How long failed jobs are kept, in days, before both BullMQ drops the payload
 * and the retention sweep deletes the matching analysis_jobs row.
 *
 * Failed jobs hold a full diff plus the AI response, so this is a bound on
 * Redis growth rather than an arbitrary cleanup interval.
 */
export const JOB_RETENTION_DAYS = parseInt(process.env.JOB_RETENTION_DAYS || '7', 10);

/** BullMQ's removeOnFail age is in seconds, while the sweep works in days. */
export const FAILED_JOB_RETENTION_SECONDS = JOB_RETENTION_DAYS * 24 * 60 * 60;

/** Deletes analysis_jobs rows in batches of this size. */
export const DELETE_BATCH_SIZE = 500;

/* -------------------------------------------------------------------------- */
/* Retention sweep                                                            */
/* -------------------------------------------------------------------------- */

/** 6h. */
export const SWEEP_INTERVAL_MS = parseInt(process.env.JOB_SWEEP_INTERVAL_MS || '21600000', 10);
export const SWEEP_ENABLED = process.env.JOB_RETENTION_SWEEP !== 'false';

/* -------------------------------------------------------------------------- */
/* Repository poller                                                          */
/* -------------------------------------------------------------------------- */

/** 60s. */
export const POLL_INTERVAL_MS = parseInt(process.env.REPO_POLL_INTERVAL_MS || '60000', 10);
export const POLL_ENABLED = process.env.REPO_POLL_ENABLED !== 'false';

/* -------------------------------------------------------------------------- */
/* Analysis worker                                                            */
/* -------------------------------------------------------------------------- */

/** 10 minutes. */
export const REVIEW_TIMEOUT_MS = parseInt(process.env.REVIEW_TIMEOUT_MS || '', 10) || 10 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Job query limits                                                           */
/* -------------------------------------------------------------------------- */

/** Upper bound on `?limit=`, so a client cannot ask for the whole table. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* Billing webhook events                                                     */
/* -------------------------------------------------------------------------- */

/** Tiers that grant paid entitlements. */
export const PAID_TIERS = new Set<string>(['INDIE', 'TEAM']);

/** Events that (re)write entitlement state. */
export const SYNC_EVENTS = new Set([
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.resumed',
  'subscription.uncanceled',
  'subscription.cycled',
  'subscription.migrated',
  'subscription.past_due',
  'subscription.paused',
]);

/** Events that end entitlement for the referenced subscription. */
export const CANCEL_EVENTS = new Set(['subscription.canceled', 'subscription.revoked']);

/* -------------------------------------------------------------------------- */
/* AI providers                                                               */
/* -------------------------------------------------------------------------- */

export const VALID_PROVIDERS = new Set<AiProvider>([
  AiProvider.GEMINI,
  AiProvider.OPENAI,
  AiProvider.CLAUDE,
  AiProvider.GROK,
]);

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
export const GROK_BASE_URL = process.env.GROK_BASE_URL || 'https://api.x.ai/v1';
export const GROK_MODEL = process.env.GROK_MODEL || 'grok-2-1212';

/* -------------------------------------------------------------------------- */
/* Review context (Phase 2)                                                    */
/* -------------------------------------------------------------------------- */

/** How far to walk the import graph out from the changed files. */
export const CONTEXT_MAX_HOPS = parseInt(process.env.CONTEXT_MAX_HOPS || '2', 10);

/** Hard ceiling on neighbour files fetched and sent to the model. */
export const CONTEXT_MAX_FILES = parseInt(process.env.CONTEXT_MAX_FILES || '25', 10);

/** Ceiling on context characters, ~4 chars per token. Keeps cost predictable. */
export const CONTEXT_MAX_TOKENS = parseInt(process.env.CONTEXT_MAX_TOKENS || '30000', 10);
export const CONTEXT_MAX_CHARS = CONTEXT_MAX_TOKENS * 4;

/**
 * Retention for cached source blobs (customer code).
 *
 * The shipped default is indefinite: cached code is kept until its repository
 * is disconnected. Setting a positive value opts into an absolute expiry that
 * the hourly sweep enforces instead.
 *
 * A malformed value fails safe to a short window rather than to indefinite,
 * because a typo should not silently authorise keeping code forever.
 */
const parsedRetention = parseInt(process.env.CONTEXT_RETENTION_HOURS || '0', 10);
export const CONTEXT_RETENTION_HOURS = Number.isFinite(parsedRetention) ? parsedRetention : 24;

/** True when cached code is kept until the repository is disconnected. */
export const CONTEXT_RETAIN_INDEFINITELY = CONTEXT_RETENTION_HOURS <= 0;

export const CONTEXT_SWEEP_ENABLED = process.env.CONTEXT_SWEEP_ENABLED !== 'false';

/** File extensions parsed for import edges and symbol occurrences. */
export const CONTEXT_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
]);

/** Files above this size are fetched but skipped for parsing/context. */
export const CONTEXT_MAX_FILE_BYTES = parseInt(process.env.CONTEXT_MAX_FILE_BYTES || '200000', 10);

/** Directories never worth walking into for context. */
export const CONTEXT_EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', 'vendor',
  '__pycache__', '.venv', 'venv', 'target', 'bower_components',
]);