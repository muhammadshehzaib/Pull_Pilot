ALTER TABLE repositories ADD COLUMN "feedbackAdaptationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "feedbackAdaptationRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repository_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sourceOccurrenceId" TEXT,
  ADD COLUMN "creationKey" TEXT,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "repository_rules_repositoryId_creationKey_key" ON repository_rules("repositoryId", "creationKey");
ALTER TABLE repository_rules ADD CONSTRAINT "repository_rules_sourceOccurrenceId_fkey"
  FOREIGN KEY ("sourceOccurrenceId") REFERENCES finding_occurrences(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TYPE "FindingWorkflowStatus" AS ENUM ('OPEN', 'DISMISSED', 'REPORTED_FIXED');
CREATE TABLE finding_workflows (
  id TEXT PRIMARY KEY, "occurrenceId" TEXT NOT NULL UNIQUE,
  status "FindingWorkflowStatus" NOT NULL DEFAULT 'OPEN', "actorId" TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("occurrenceId") REFERENCES finding_occurrences(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE finding_workflow_events (
  id TEXT PRIMARY KEY, "workflowId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  "fromStatus" "FindingWorkflowStatus" NOT NULL, status "FindingWorkflowStatus" NOT NULL,
  revision INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("workflowId") REFERENCES finding_workflows(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "finding_workflow_events_workflowId_createdAt_idx" ON finding_workflow_events("workflowId", "createdAt");
CREATE TABLE rule_audit_events (
  id TEXT PRIMARY KEY, "repositoryId" TEXT NOT NULL, "ruleId" TEXT, "actorId" TEXT NOT NULL,
  action TEXT NOT NULL, revision INTEGER NOT NULL, "creationKey" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("repositoryId") REFERENCES repositories(id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("ruleId") REFERENCES repository_rules(id) ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "rule_audit_events_repositoryId_createdAt_idx" ON rule_audit_events("repositoryId", "createdAt");
CREATE UNIQUE INDEX "rule_audit_events_repositoryId_creationKey_key" ON rule_audit_events("repositoryId", "creationKey");
