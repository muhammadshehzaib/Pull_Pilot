-- Phase 8: Historical Intelligence
-- Migration: 20261016000000_historical_intelligence

-- 1. Opt-in flag on repositories
ALTER TABLE "repositories" ADD COLUMN "historicalIntelligenceEnabled" BOOLEAN NOT NULL DEFAULT false;

-- 2. New enums
CREATE TYPE "FeedbackDisposition" AS ENUM ('UNREVIEWED', 'ACCEPTED', 'REJECTED', 'NEEDS_REVIEW');
CREATE TYPE "RejectionReason" AS ENUM ('FALSE_POSITIVE', 'DUPLICATE', 'INTENDED_BEHAVIOR', 'OUT_OF_SCOPE', 'STYLE_PREFERENCE', 'OTHER');

-- 3. Stable finding identity
CREATE TABLE "finding_occurrences" (
  "id"            TEXT NOT NULL,
  "repositoryId"  TEXT NOT NULL,
  "analysisJobId" TEXT NOT NULL,
  "snapshotKey"   TEXT NOT NULL,
  "filePath"      TEXT NOT NULL,
  "lineNumber"    INTEGER NOT NULL,
  "category"      "FindingCategory" NOT NULL,
  "severity"      "FindingSeverity" NOT NULL,
  "source"        TEXT NOT NULL,
  "sources"       JSONB NOT NULL DEFAULT '[]',
  "ruleKeys"      JSONB NOT NULL DEFAULT '[]',
  "summary"       VARCHAR(500) NOT NULL,
  "fingerprint"   TEXT NOT NULL,
  "superseded"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finding_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_occurrences_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "finding_occurrences_analysisJobId_fkey"
    FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "finding_occurrences_snapshotKey_key" ON "finding_occurrences"("snapshotKey");
CREATE INDEX "finding_occurrences_repositoryId_fingerprint_idx" ON "finding_occurrences"("repositoryId", "fingerprint");
CREATE INDEX "finding_occurrences_analysisJobId_idx" ON "finding_occurrences"("analysisJobId");
CREATE INDEX "finding_occurrences_repositoryId_createdAt_idx" ON "finding_occurrences"("repositoryId", "createdAt");

-- 4. Developer feedback (current state)
CREATE TABLE "finding_feedbacks" (
  "id"              TEXT NOT NULL,
  "occurrenceId"    TEXT NOT NULL,
  "actorId"         TEXT NOT NULL,
  "disposition"     "FeedbackDisposition" NOT NULL DEFAULT 'UNREVIEWED',
  "rejectionReason" "RejectionReason",
  "note"            VARCHAR(1000),
  "revision"        INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "finding_feedbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_feedbacks_occurrenceId_fkey"
    FOREIGN KEY ("occurrenceId") REFERENCES "finding_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "finding_feedbacks_occurrenceId_key" ON "finding_feedbacks"("occurrenceId");

-- 5. Feedback audit trail (append-only)
CREATE TABLE "finding_feedback_events" (
  "id"              TEXT NOT NULL,
  "feedbackId"      TEXT NOT NULL,
  "actorId"         TEXT NOT NULL,
  "disposition"     "FeedbackDisposition" NOT NULL,
  "rejectionReason" "RejectionReason",
  "revision"        INTEGER NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finding_feedback_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_feedback_events_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "finding_feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "finding_feedback_events_feedbackId_idx" ON "finding_feedback_events"("feedbackId");

-- 6. Historical pattern aggregates
CREATE TABLE "historical_patterns" (
  "id"                  TEXT NOT NULL,
  "repositoryId"        TEXT NOT NULL,
  "fingerprint"         TEXT NOT NULL,
  "algorithmVersion"    TEXT NOT NULL DEFAULT 'fp_v1',
  "category"            "FindingCategory" NOT NULL,
  "source"              TEXT NOT NULL,
  "summary"             VARCHAR(300) NOT NULL,
  "occurrenceCount"     INTEGER NOT NULL DEFAULT 0,
  "distinctPrCount"     INTEGER NOT NULL DEFAULT 0,
  "acceptedCount"       INTEGER NOT NULL DEFAULT 0,
  "rejectedCount"       INTEGER NOT NULL DEFAULT 0,
  "rejectionReasons"    JSONB NOT NULL DEFAULT '{}',
  "unreviewedCount"     INTEGER NOT NULL DEFAULT 0,
  "representativePaths" JSONB NOT NULL DEFAULT '[]',
  "firstObservedAt"     TIMESTAMP(3) NOT NULL,
  "lastObservedAt"      TIMESTAMP(3) NOT NULL,
  "aggregatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "historical_patterns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "historical_patterns_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "historical_patterns_repositoryId_fingerprint_algorithmVersion_key"
  ON "historical_patterns"("repositoryId", "fingerprint", "algorithmVersion");
CREATE INDEX "historical_patterns_repositoryId_distinctPrCount_idx"
  ON "historical_patterns"("repositoryId", "distinctPrCount");
