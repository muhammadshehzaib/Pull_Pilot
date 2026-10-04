-- Encrypted, content-addressed cache of repository file contents.
--
-- Phase 2 review context needs the code *around* a diff, not just the diff.
-- Reading that through the contents API is one request per path, but a blob
-- SHA identifies content, so storing by SHA means the same bytes are stored
-- once and reused across commits, jobs and reviewers for that repository.
--
-- Customer source code lands in this table, so the payload is the AES-256-GCM
-- envelope from EncryptionService rather than plaintext, and every row
-- carries an absolute expiresAt that a sweeper enforces. This is a short-lived
-- working set for assembling context, not a mirror of the repository.

CREATE TABLE "cached_files" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cached_files_pkey" PRIMARY KEY ("id")
);

-- Content addressing: one row per distinct blob per repository. Repositories
-- are kept in the key so identical blobs in different repositories are never
-- shared, which keeps private code isolated even when two repos vendor the
-- same dependency.
CREATE UNIQUE INDEX "cached_files_repositoryId_blobSha_key" ON "cached_files"("repositoryId", "blobSha");

-- Supports the retention sweep, which scans by expiry rather than by repo.
CREATE INDEX "cached_files_expiresAt_idx" ON "cached_files"("expiresAt");

ALTER TABLE "cached_files" ADD CONSTRAINT "cached_files_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;