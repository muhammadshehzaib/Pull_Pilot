-- Remember a repository's default branch (e.g. "main" or "master").
--
-- Push and whole-branch audits need to know which branch to read. Previously
-- this was rediscovered with an extra GitHub API call every time an audit ran
-- without an explicit branch. Persisting it lets those paths read the stored
-- value and lets the dashboard show which branch is being watched.

ALTER TABLE "repositories" ADD COLUMN "defaultBranch" TEXT;