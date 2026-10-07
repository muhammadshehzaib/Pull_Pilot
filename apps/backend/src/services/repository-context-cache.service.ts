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
   * How long a cached blob is considered usable. Zero or negative means
   * indefinite: rows are written without an expiry. Overridable for tests.
   */
  private readonly retentionMs: number;

  constructor(retentionMs: number = CONTEXT_RETENTION_HOURS * 60 * 60 * 1000) {
    this.retentionMs = retentionMs;
  }

  /** True when this cache writes an expiry at all. */
  private get hasExpiry(): boolean {
    return this.retentionMs > 0;
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
   * An expired row is deleted rather than returned; a row with no expiry
   * is returned for as long as its repository is connected.
   */
  async get(repositoryId: string, blobSha: string): Promise<string | null> {
    const row = await prisma.cachedFile.findUnique({
      where: { repositoryId_blobSha: { repositoryId, blobSha } },
    });
    if (!row) return null;

    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
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
    // Indefinite retention writes no expiry at all, rather than a far-future
    // date that would misrepresent what the row means.
    const expiresAt = this.hasExpiry ? new Date(Date.now() + this.retentionMs) : null;

    const existing = await prisma.cachedFile.findUnique({
      where: { repositoryId_blobSha: { repositoryId, blobSha } },
    });
    if (existing && (existing.expiresAt === null || existing.expiresAt.getTime() > Date.now())) return;

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

  /**
   * Enforces the current retention policy. Returns rows deleted.
   *
   * Rows with no expiry are collected by exactly two things: their repository
   * being disconnected (ON DELETE CASCADE), or the policy below.
   *
   * A null expiry means "keep until disconnected" while that is the setting.
   * Once a finite window is configured, those rows would otherwise outlive the
   * policy that replaced it, so the sweep gives them a deadline first.
   */
  async sweepExpired(): Promise<number> {
    if (this.hasExpiry) {
      await prisma.cachedFile.updateMany({
        where: { expiresAt: null },
        data: { expiresAt: new Date(Date.now() + this.retentionMs) },
      });
    }

    const result = await prisma.cachedFile.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return result.count;
  }

  /**
   * Deletes all cached content for a repository. Called on every disconnect
   * path (dashboard deactivation, repository removed from the installation,
   * and app uninstall) since indefinite retention means nothing else expires.
   */
  async clearRepository(repositoryId: string): Promise<void> {
    await prisma.cachedFile.deleteMany({ where: { repositoryId } });
  }
}