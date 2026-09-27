-- Reconciles the database with schema.prisma.
--
-- The 20260703000000_init migration predates the GitHub App / marketplace work,
-- so it never created the `installations` and `usage_ledgers` tables, the
-- `PlanTier` enum, the `JobStatus.SKIPPED` value, or the two new columns on
-- `repositories`. Local development never noticed because it used `prisma db push`
-- (root `prisma:push` script), which ignores migrations entirely. Production runs
-- `prisma migrate deploy` on container boot (apps/backend/Dockerfile:32), so any
-- fresh deploy would come up without these tables and crash on the first
-- `prisma.installation.findUnique` in webhook.controller.ts.
--
-- This migration is purely additive: no data is dropped or rewritten.

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'INDIE', 'TEAM');

-- AlterEnum
-- Safe inside Prisma's per-migration transaction on PostgreSQL 12+ (this project
-- runs postgres:15-alpine): the new value is only disallowed if it is *used*
-- within the same transaction, and nothing below reads it.
ALTER TYPE "JobStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "installationId" TEXT,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "installations" (
    "id" TEXT NOT NULL,
    "githubInstallationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'User',
    "avatarUrl" TEXT,
    "plan" "PlanTier" NOT NULL DEFAULT 'FREE',
    "marketplacePlanId" BIGINT,
    "marketplacePlanName" TEXT,
    "marketplaceUnitCount" INTEGER NOT NULL DEFAULT 1,
    "marketplaceStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "nextBillingDate" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledgers" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "billingMonth" TEXT NOT NULL,
    "publicReviewsCount" INTEGER NOT NULL DEFAULT 0,
    "privateReviewsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_githubInstallationId_key" ON "installations"("githubInstallationId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledgers_installationId_billingMonth_key" ON "usage_ledgers"("installationId", "billingMonth");

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledgers" ADD CONSTRAINT "usage_ledgers_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
