-- Idempotency: remember which commit each job reviewed so a redelivered GitHub
-- webhook does not trigger a second, duplicate review.
--
-- commitSha is nullable on purpose. NULLs are excluded from unique constraints in
-- Postgres, so manual reviews (POST /api/jobs/...) and pre-existing rows are not
-- forced into a shared key.

-- AlterTable
ALTER TABLE "analysis_jobs" ADD COLUMN "commitSha" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "analysis_jobs_repositoryId_eventType_referenceId_commitSha_key" ON "analysis_jobs"("repositoryId", "eventType", "referenceId", "commitSha");

-- CreateIndex
CREATE INDEX "analysis_jobs_commitSha_idx" ON "analysis_jobs"("commitSha");