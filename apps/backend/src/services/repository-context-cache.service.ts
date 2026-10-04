import prisma from '../config/prisma';
import { EncryptionService } from './encryption.service';
import {
  CONTEXT_RETENTION_HOURS,
  CONTEXT_EXCLUDED_SEGMENTS,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_SOURCE_EXTENSIONS,
} from '../utils/constants';

/**
 * Short-lived, encrypted store of repository file contents.
 *
 * Context-aware reviews need the code around a diff. Fetching it per path is
 * one API call per file, so contents are cached keyed by Git blob SHA: the same
 * bytes keep the same SHA across every commit they appear in, which means an
 * unchanged file is fetched once and reused by later reviews.
 *
 * This deliberately holds customer source code, so:
 *  - payloads are AES-256-GCM envelopes, never plaintext;
 *  - every row carries an absolute expiry and the sweeper deletes past it;
 *  - identical blobs in different repositories are never shared, so one
 *    customer's code is never reachable from another's review.
 *
 * A cache miss is never fatal. If encryption, storage or the API fails, the
 * caller reviews the diff without the extra file; a degraded review beats a
 * failed one.
 */
export class RepositoryContextCache {
  /**
   * How long a cached blob is considered usable. Overridable for tests.
   */
  private readonly retentionMs: number;

  constructor(retentionMs: number = CONTEXT_RETENTION_HOURS * 60 * 60 * 1000) {
    this.retentionMs = retentionMs;
  }

  /** True when this file is worth fetching and parsing for context. */
  static isContextCandidate(path: string, sizeBytes: number): boolean {
    if (sizeBytes > CONTEXT_MAX_FILE_BYTES) return false;

    const segments = path.split('/');
    // Any excluded directory anywhere in the path disqualifies the file, so
    // `packages/app/node_modules/...` is skipped like a root-level one.
    if (segments.some((s) => CONTEXT_EXCLUDED_SEGMENTS.has(s))) return false;
    // Hidden directories are skipped, but a dot-prefixed *file* is fine:
    // `src/.eslintrc.js` is real source context, `.github/scripts/run.ts` is not.
    const dirs = segments.slice(0, -1);
    if (dirs.some((s) => s.startsWith('.') && s !== '.' && s !== '..')) return false;

    const dot = path.lastIndexOf('.');
    if (dot === -1) return false;
    return CONTEXT_SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
  }

  /**
   * Returns the decrypted content for a blob, or null on a miss.
   * An expired row is deleted rather than returned.
   */
  async get(repositoryId: string, blobSha: string): Promise<string | null> {
    const row = await prisma.cachedFile.findUnique({
      where: { repositoryId_blobSha: { repositoryId, blobSha } },
    });
    if (!row) return null;

    if (row.expiresAt.getTime() <= Date.now()) {
      await prisma.cachedFile.delete({ where: { id: row.id } }).catch(() => undefined);
      return null;
    }

    try {
      return EncryptionService.decrypt(row.encryptedData, row.iv, row.authTag, row.salt);
    } catch {
      // A key rotation makes old rows undecryptable. Dropping one is safe
      // because the blob is still fetchable from GitHub.
      await prisma.cachedFile.delete({ where: { id: row.id } }).catch(() => undefined);
      return null;
    }
  }

  /**
   * Stores encrypted content under its blob SHA. An existing unexpired row is
   * kept so the write path stays idempotent for repeated reviews.
   */
  async put(
    repositoryId: string,
    blobSha: string,
    path: string,
    content: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.retentionMs);

    const existing = await prisma.cachedFile.findUnique({
      where: { repositoryId_blobSha: { repositoryId, blobSha } },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) return;

    const sealed = EncryptionService.encrypt(content);

    await prisma.cachedFile.upsert({
      where: { repositoryId_blobSha: { repositoryId, blobSha } },
      create: {
        repositoryId,
        blobSha,
        path,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        encryptedData: sealed.encryptedData,
        iv: sealed.iv,
        authTag: sealed.authTag,
        salt: sealed.salt,
        expiresAt,
      },
      update: {
        path,
        encryptedData: sealed.encryptedData,
        iv: sealed.iv,
        authTag: sealed.authTag,
        salt: sealed.salt,
        expiresAt,
      },
    });
  }

  /** Deletes every expired row. Returns the number removed. */
  async sweepExpired(): Promise<number> {
    const result = await prisma.cachedFile.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return result.count;
  }

  /** Test seam. Clears all cached content for a repository. */
  async clearRepository(repositoryId: string): Promise<void> {
    await prisma.cachedFile.deleteMany({ where: { repositoryId } });
  }
}