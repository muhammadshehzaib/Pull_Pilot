-- Keep the source PR revision separate from the target base branch revision.
-- This lets test-PR creation reject a draft after the source PR has changed.
ALTER TABLE "test_drafts"
ADD COLUMN "sourceHeadSha" TEXT;
