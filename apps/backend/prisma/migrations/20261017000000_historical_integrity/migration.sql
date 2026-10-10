ALTER TABLE "repositories"
  ADD COLUMN "historicalRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "historicalAggregatedRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN "historicalAggregatedAt" TIMESTAMP(3);
ALTER TABLE "analysis_jobs"
  ADD COLUMN "findingSnapshot" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "findingSnapshotHash" TEXT;
ALTER TABLE "finding_occurrences" ADD COLUMN "findingKey" TEXT NOT NULL DEFAULT '';
-- Old keys used case-insensitive paths. Rebuild from case-preserved occurrences.
DELETE FROM "historical_patterns";
ALTER TABLE "historical_patterns" ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Job deletion cascades must invalidate derived memory as well as raw feedback.
CREATE FUNCTION invalidate_deleted_historical_occurrence() RETURNS trigger AS $$
BEGIN
  UPDATE repositories SET "historicalRevision" = "historicalRevision" + 1 WHERE id = OLD."repositoryId";
  DELETE FROM historical_patterns WHERE "repositoryId" = OLD."repositoryId";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER historical_occurrence_deleted AFTER DELETE ON finding_occurrences
FOR EACH ROW EXECUTE FUNCTION invalidate_deleted_historical_occurrence();
