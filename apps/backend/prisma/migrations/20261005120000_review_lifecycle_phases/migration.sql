-- Granular review lifecycle.
--
-- The worker used to write a single RUNNING flag, so a review looked
-- identical whether it was fetching the diff, waiting on a model, or posting
-- comments. A user watching a 4-minute review had no way to tell a stuck job
-- from a slow one. These phases are what the worker's advanceReview() writes.

-- AlterEnum
-- Added ahead of the first review run that uses them. PostgreSQL cannot use a
-- new enum label in the same transaction that adds it, so each statement stays
-- separate and no data is touched here; existing rows keep RUNNING.
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'FETCHING';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'ANALYZING';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'GENERATING';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'POSTING';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'TIMEOUT';