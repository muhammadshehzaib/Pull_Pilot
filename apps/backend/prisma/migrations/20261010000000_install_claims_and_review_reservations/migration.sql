-- One-time ownership handoff from the GitHub App setup redirect.
ALTER TABLE "installations" ADD COLUMN "createdByGithubId" TEXT;
CREATE TABLE "installation_claims" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "installation_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "installation_claims_stateHash_key" ON "installation_claims"("stateHash");
CREATE INDEX "installation_claims_expiresAt_idx" ON "installation_claims"("expiresAt");
ALTER TABLE "installation_claims" ADD CONSTRAINT "installation_claims_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Queue acceptance reserves quota immediately. User ledgers also cover legacy
-- PAT repositories that do not belong to a GitHub App installation.
ALTER TABLE "usage_ledgers" ALTER COLUMN "installationId" DROP NOT NULL;
ALTER TABLE "usage_ledgers" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "usage_ledgers_userId_billingMonth_key" ON "usage_ledgers"("userId", "billingMonth");
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A repository may only appear once under a given installation.
CREATE UNIQUE INDEX "repositories_installationId_githubRepoId_key"
  ON "repositories"("installationId", "githubRepoId");

ALTER TYPE "JobStatus" ADD VALUE 'RETRYING';
