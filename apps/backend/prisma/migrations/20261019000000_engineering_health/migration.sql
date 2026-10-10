ALTER TABLE repositories ADD COLUMN "analyticsStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE analysis_jobs ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "analyticsRevision" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "analyticsHash" TEXT;
CREATE INDEX "analysis_jobs_repositoryId_status_createdAt_idx" ON analysis_jobs("repositoryId", status, "createdAt");
CREATE TABLE review_analytics_facts (
  id TEXT PRIMARY KEY, "repositoryId" TEXT NOT NULL, "analysisJobId" TEXT NOT NULL,
  "artifactRevision" INTEGER NOT NULL, "findingSnapshot" INTEGER NOT NULL,
  "referenceId" TEXT NOT NULL, "eventType" "EventType" NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL, "jobCreatedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "timestampQuality" TEXT NOT NULL, "metricsVersion" TEXT NOT NULL,
  "riskAlgorithmVersion" TEXT NOT NULL, "configurationSignature" TEXT NOT NULL, "riskScore" DOUBLE PRECISION,
  "criticalCount" INTEGER NOT NULL, "highCount" INTEGER NOT NULL, "mediumCount" INTEGER NOT NULL,
  "lowCount" INTEGER NOT NULL, "infoCount" INTEGER NOT NULL, "securityCount" INTEGER NOT NULL,
  "testGapCount" INTEGER, coverage JSONB NOT NULL,
  FOREIGN KEY ("repositoryId") REFERENCES repositories(id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("analysisJobId") REFERENCES analysis_jobs(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "review_analytics_facts_analysisJobId_artifactRevision_key" ON review_analytics_facts("analysisJobId", "artifactRevision");
CREATE INDEX "review_analytics_facts_repositoryId_completedAt_idx" ON review_analytics_facts("repositoryId", "completedAt");
CREATE INDEX "review_analytics_facts_repositoryId_referenceId_completedAt_idx" ON review_analytics_facts("repositoryId", "referenceId", "completedAt");
CREATE INDEX "review_analytics_facts_expiresAt_idx" ON review_analytics_facts("expiresAt");
