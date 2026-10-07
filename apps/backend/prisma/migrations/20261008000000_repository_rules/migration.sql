-- Per-repository engineering rules and their per-job check results.
--
-- Rules previously lived only in .aipr.yml and only steered the model's
-- prompt, so there was no way to manage them from the dashboard and no record
-- of whether a rule actually held. `repository_rules` stores the rules (LLM
-- wording, deterministic regex, or both), and `rule_checks` records a
-- PASS/FAIL/SKIPPED outcome for every rule on every analysis job.

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('SECURITY', 'BUG', 'CORRECTNESS', 'PERFORMANCE', 'ARCHITECTURE', 'MAINTAINABILITY', 'STYLE', 'TESTING');

-- CreateEnum
CREATE TYPE "RuleEnforcement" AS ENUM ('LLM', 'DETERMINISTIC', 'BOTH');

-- CreateEnum
CREATE TYPE "RuleCheckStatus" AS ENUM ('PASS', 'FAIL', 'SKIPPED');

-- CreateTable
CREATE TABLE "repository_rules" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "guideline" TEXT,
    "pattern" TEXT,
    "severity" "FindingSeverity" NOT NULL DEFAULT 'MEDIUM',
    "category" "FindingCategory" NOT NULL DEFAULT 'MAINTAINABILITY',
    "enforcement" "RuleEnforcement" NOT NULL DEFAULT 'LLM',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_checks" (
    "id" TEXT NOT NULL,
    "analysisJobId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT NOT NULL,
    "status" "RuleCheckStatus" NOT NULL,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repository_rules_repositoryId_idx" ON "repository_rules"("repositoryId");

-- CreateIndex
CREATE INDEX "rule_checks_ruleId_idx" ON "rule_checks"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "rule_checks_analysisJobId_ruleId_key" ON "rule_checks"("analysisJobId", "ruleId");

-- AddForeignKey
ALTER TABLE "repository_rules" ADD CONSTRAINT "repository_rules_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_checks" ADD CONSTRAINT "rule_checks_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_checks" ADD CONSTRAINT "rule_checks_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "repository_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
