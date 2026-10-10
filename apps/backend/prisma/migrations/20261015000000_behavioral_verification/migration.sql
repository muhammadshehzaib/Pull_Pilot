ALTER TABLE "repositories" ADD COLUMN "behavioralConfig" JSONB;
CREATE TYPE "BehavioralRunStatus" AS ENUM ('NOT_RUN', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'TIMED_OUT', 'ERROR');
CREATE TABLE "behavioral_runs" (
  "id" TEXT NOT NULL,
  "analysisJobId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "status" "BehavioralRunStatus" NOT NULL DEFAULT 'NOT_RUN',
  "headSha" TEXT NOT NULL,
  "deploymentId" INTEGER,
  "previewUrl" TEXT,
  "workflowSha" TEXT NOT NULL,
  "workflowRef" TEXT NOT NULL,
  "dispatchHash" TEXT NOT NULL,
  "ciRunId" TEXT,
  "plan" JSONB NOT NULL,
  "evidence" JSONB,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "behavioral_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "behavioral_runs_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "behavioral_runs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "behavioral_runs_analysisJobId_requestKey_key" ON "behavioral_runs"("analysisJobId", "requestKey");
CREATE INDEX "behavioral_runs_repositoryId_createdAt_idx" ON "behavioral_runs"("repositoryId", "createdAt");
CREATE INDEX "behavioral_runs_status_deadlineAt_idx" ON "behavioral_runs"("status", "deadlineAt");
CREATE INDEX "behavioral_runs_expiresAt_idx" ON "behavioral_runs"("expiresAt");
