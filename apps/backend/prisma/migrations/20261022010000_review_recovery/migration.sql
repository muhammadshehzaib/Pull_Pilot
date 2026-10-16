ALTER TABLE "analysis_jobs"
  ADD COLUMN "queueVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queueJobId" TEXT,
  ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "quotaLedgerId" TEXT,
  ADD COLUMN "quotaIsPrivate" BOOLEAN,
  ADD COLUMN "quotaRefundedAt" TIMESTAMP(3);

ALTER TABLE "analysis_jobs" ALTER COLUMN "queueVersion" SET DEFAULT 1;

CREATE INDEX "analysis_jobs_status_id_idx" ON "analysis_jobs"("status", "id");
