CREATE TABLE "cached_imports" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL,
    "parserVersion" INTEGER NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "cached_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cached_imports_repositoryId_blobSha_parserVersion_key"
    ON "cached_imports"("repositoryId", "blobSha", "parserVersion");
CREATE INDEX "cached_imports_expiresAt_idx" ON "cached_imports"("expiresAt");
ALTER TABLE "cached_imports" ADD CONSTRAINT "cached_imports_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
