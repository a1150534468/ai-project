ALTER TABLE "Session"
  ADD COLUMN "agentId" TEXT,
  ADD COLUMN "agentName" TEXT,
  ADD COLUMN "agentPrompt" TEXT;

CREATE INDEX "Session_userId_agentId_idx" ON "Session"("userId", "agentId");

CREATE TABLE "UserAgent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "prompt" TEXT NOT NULL,
  "modelUsed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserAgent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserAgent_userId_createdAt_idx" ON "UserAgent"("userId", "createdAt");

ALTER TABLE "UserAgent"
  ADD CONSTRAINT "UserAgent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
