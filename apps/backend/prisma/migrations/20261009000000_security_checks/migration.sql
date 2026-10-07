-- Deterministic security layer: one outcome row per security probe per
-- analysis job, mirroring rule_checks.
--
-- The worker runs three probes against the filtered diff before the model is
-- called — SAST (static analysis with hardcoded rules, not a model opinion),
-- SECRETS (hardcoded credentials / high-entropy keys), and DEPENDENCIES
-- (known-vulnerable ranges in changed manifests). Each probe writes a
-- PASS/FAIL/SKIPPED row here; the findings themselves are normal SECURITY
-- suggestions inside `analysis_jobs.results`. The risk-engine verdict and
-- score are stored on the job as `analysis_jobs.results.risk`.

-- CreateEnum
CREATE TYPE "SecurityProbe" AS ENUM ('SAST', 'SECRETS', 'DEPENDENCIES');

-- CreateEnum
CREATE TYPE "SecurityCheckStatus" AS ENUM ('PASS', 'FAIL', 'SKIPPED');

-- CreateTable
CREATE TABLE "security_checks" (
    "id" TEXT NOT NULL,
    "analysisJobId" TEXT NOT NULL,
    "probe" "SecurityProbe" NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "status" "SecurityCheckStatus" NOT NULL,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_checks_analysisJobId_idx" ON "security_checks"("analysisJobId");

-- CreateIndex
CREATE INDEX "security_checks_probe_idx" ON "security_checks"("probe");

-- CreateIndex
CREATE UNIQUE INDEX "security_checks_analysisJobId_probe_ruleKey_key" ON "security_checks"("analysisJobId", "probe", "ruleKey");

-- AddForeignKey
ALTER TABLE "security_checks" ADD CONSTRAINT "security_checks_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;