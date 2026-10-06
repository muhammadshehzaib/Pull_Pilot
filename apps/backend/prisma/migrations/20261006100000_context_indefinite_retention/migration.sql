-- Allow cached source blobs to have no expiry.
--
-- Retention for cached repository code is now configurable down to keeping it
-- for as long as the repository stays connected. That cannot be expressed with
-- a required expiresAt: a far-future date would be a lie about the data, and
-- the sweep would still be the thing deciding the lifetime.
--
-- A null expiresAt therefore means "no expiry". The row is removed by one of
-- exactly two things: a repository being disconnected (ON DELETE CASCADE), or
-- an explicit clear. The sweep only ever matches rows that have an expiry set,
-- so nulls are never collected by it.

ALTER TABLE "cached_files" ALTER COLUMN "expiresAt" DROP NOT NULL;
