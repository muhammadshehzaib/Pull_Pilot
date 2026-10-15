CREATE TABLE "revoked_sessions" (
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "revoked_sessions_expiresAt_idx" ON "revoked_sessions"("expiresAt");
