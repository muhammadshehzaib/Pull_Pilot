-- Replace GitHub Marketplace billing with Polar (merchant of record).
--
-- We are the GitHub App; Polar is the payment provider. Entitlements now come
-- from our own `subscriptions` table instead of `marketplace_purchase` webhooks.

-- AlterTable
-- Drop the GitHub Marketplace bookkeeping columns. Nothing populated them for
-- real (the listing was never published), and keeping them would leave a second,
-- stale source of truth for plan state.
ALTER TABLE "installations" DROP COLUMN "marketplacePlanId";
ALTER TABLE "installations" DROP COLUMN "marketplacePlanName";
ALTER TABLE "installations" DROP COLUMN "marketplaceUnitCount";
ALTER TABLE "installations" DROP COLUMN "marketplaceStatus";
ALTER TABLE "installations" DROP COLUMN "billingCycle";
ALTER TABLE "installations" DROP COLUMN "nextBillingDate";

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'polar',
    "polarCustomerId" TEXT,
    "polarSubscriptionId" TEXT,
    "polarProductId" TEXT,
    "plan" "PlanTier" NOT NULL DEFAULT 'FREE',
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Postgres excludes NULLs from unique constraints, so users without a Polar
-- subscription (free tier, or a one-time order) never collide here.
CREATE UNIQUE INDEX "subscriptions_polarSubscriptionId_key" ON "subscriptions"("polarSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_idx" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX "subscriptions_polarCustomerId_idx" ON "subscriptions"("polarCustomerId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;