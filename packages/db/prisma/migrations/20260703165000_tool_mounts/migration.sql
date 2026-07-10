ALTER TABLE "Session" ADD COLUMN "attachedToolIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Device"
  ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "tools" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "UserToolInstall" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "categoryKey" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "toolName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'installed',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserToolInstall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserToolInstall_userId_marketId_key" ON "UserToolInstall"("userId", "marketId");
CREATE UNIQUE INDEX "UserToolInstall_userId_toolName_key" ON "UserToolInstall"("userId", "toolName");
CREATE INDEX "UserToolInstall_userId_updatedAt_idx" ON "UserToolInstall"("userId", "updatedAt");

ALTER TABLE "UserToolInstall"
  ADD CONSTRAINT "UserToolInstall_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
