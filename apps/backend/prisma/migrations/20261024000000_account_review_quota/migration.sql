-- Merge legacy installation counters into one account/month ledger. Retarget
-- receipts before deleting legacy rows so retries and refunds retain their charge.
BEGIN;
LOCK TABLE "analysis_jobs", "usage_ledgers", "installations" IN ACCESS EXCLUSIVE MODE;
INSERT INTO "usage_ledgers" ("id", "userId", "billingMonth", "publicReviewsCount", "privateReviewsCount", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text), i."userId", l."billingMonth",
       SUM(l."publicReviewsCount")::integer, SUM(l."privateReviewsCount")::integer, NOW(), NOW()
FROM "usage_ledgers" l JOIN "installations" i ON i.id = l."installationId"
WHERE i."userId" IS NOT NULL AND l."userId" IS NULL
GROUP BY i."userId", l."billingMonth"
ON CONFLICT ("userId", "billingMonth") DO UPDATE
SET "publicReviewsCount" = "usage_ledgers"."publicReviewsCount" + EXCLUDED."publicReviewsCount",
    "privateReviewsCount" = "usage_ledgers"."privateReviewsCount" + EXCLUDED."privateReviewsCount",
    "updatedAt" = NOW();

UPDATE "analysis_jobs" j SET "quotaLedgerId" = account.id
FROM "usage_ledgers" legacy
JOIN "installations" i ON i.id = legacy."installationId"
JOIN "usage_ledgers" account ON account."userId" = i."userId" AND account."billingMonth" = legacy."billingMonth"
WHERE j."quotaLedgerId" = legacy.id AND legacy."userId" IS NULL;

DELETE FROM "usage_ledgers" legacy USING "installations" i
WHERE legacy."installationId" = i.id AND i."userId" IS NOT NULL AND legacy."userId" IS NULL;
COMMIT;
