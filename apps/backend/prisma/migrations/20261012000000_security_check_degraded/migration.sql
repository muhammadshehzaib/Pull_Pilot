-- Extend the deterministic security layer with a DEGRADED probe status and a
-- human-readable detail note.
--
-- DEGRADED records a probe that ran with *reduced* coverage — the optional
-- Semgrep pass was unavailable, or the live OSV.dev lookup could not answer for
-- some packages and the bundled offline registry filled the gaps. It exists so
-- a partially-covered scan is never mistaken for a clean, full PASS.
--
-- `detail` explains a DEGRADED/SKIPPED row (which optional input was
-- unavailable, or why nothing was applicable to the diff). It is null for a
-- plain PASS/FAIL.

-- AlterEnum
ALTER TYPE "SecurityCheckStatus" ADD VALUE IF NOT EXISTS 'DEGRADED';

-- AlterTable
ALTER TABLE "security_checks" ADD COLUMN "detail" TEXT;
