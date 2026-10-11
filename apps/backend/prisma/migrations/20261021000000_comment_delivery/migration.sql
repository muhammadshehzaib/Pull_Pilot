ALTER TABLE "analysis_jobs" ADD COLUMN "deliveryVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "analysis_jobs" ALTER COLUMN "deliveryVersion" SET DEFAULT 1;
CREATE TYPE "CommentDeliveryKind" AS ENUM ('INLINE', 'SUMMARY');
CREATE TYPE "CommentDeliveryState" AS ENUM ('WAITING', 'READY', 'SENDING', 'DELIVERED', 'REJECTED', 'UNKNOWN', 'OMITTED');
CREATE TABLE "review_delivery_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "analysisJobId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "artifactHash" TEXT NOT NULL,
  "headSha" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "prNumber" INTEGER NOT NULL,
  "expectedAuthorId" TEXT NOT NULL,
  "encryptedData" TEXT,
  "iv" TEXT,
  "authTag" TEXT,
  "salt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_delivery_plans_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "review_delivery_plans_analysisJobId_key" ON "review_delivery_plans"("analysisJobId");
CREATE TABLE "comment_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "planId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "deliveryKey" TEXT NOT NULL,
  "kind" "CommentDeliveryKind" NOT NULL,
  "findingKey" TEXT,
  "path" TEXT,
  "line" INTEGER,
  "encryptedData" TEXT,
  "iv" TEXT,
  "authTag" TEXT,
  "salt" TEXT,
  "payloadHash" TEXT,
  "state" "CommentDeliveryState" NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "githubCommentId" TEXT,
  "githubUrl" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "comment_deliveries_planId_fkey" FOREIGN KEY ("planId") REFERENCES "review_delivery_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "comment_deliveries_planId_deliveryKey_key" ON "comment_deliveries"("planId", "deliveryKey");
CREATE UNIQUE INDEX "comment_deliveries_repositoryId_kind_githubCommentId_key" ON "comment_deliveries"("repositoryId", "kind", "githubCommentId");
CREATE INDEX "comment_deliveries_state_claimExpiresAt_idx" ON "comment_deliveries"("state", "claimExpiresAt");
