-- AI-drafted tests (Phase 5): one row per draft produced from a test-gap
-- scenario. Persisted server-side so a draft survives a reload, a failed GitHub
-- call can be retried without regenerating, and every read is scoped to the
-- owning user's repository.
--
-- `baseSha` is the commit the draft was written against; it is re-checked
-- before the PR is created so tests are never committed against a moved base.
-- `status` lets a PR_CREATED row short-circuit a duplicate request, and a
-- DISCARDED row keep a stale link resolving cleanly.

-- CreateEnum
CREATE TYPE "TestDraftStatus" AS ENUM ('DRAFT', 'PR_CREATED', 'DISCARDED');

-- CreateTable
CREATE TABLE "test_drafts" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "analysisJobId" TEXT,
    "userId" TEXT NOT NULL,
    "scenario" JSONB NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "targetContent" TEXT NOT NULL,
    "framework" TEXT,
    "notes" TEXT,
    "structuralNote" TEXT,
    "baseBranch" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "sourcePrNumber" INTEGER,
    "status" "TestDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "branchName" TEXT,
    "commitSha" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_drafts_repositoryId_idx" ON "test_drafts"("repositoryId");

-- CreateIndex
CREATE INDEX "test_drafts_analysisJobId_idx" ON "test_drafts"("analysisJobId");

-- CreateIndex
CREATE INDEX "test_drafts_userId_idx" ON "test_drafts"("userId");

-- AddForeignKey
ALTER TABLE "test_drafts" ADD CONSTRAINT "test_drafts_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_drafts" ADD CONSTRAINT "test_drafts_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
