-- AlterTable
ALTER TABLE "SkyhumanTask" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "DubProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '未命名口播',
    "sourceVideoUrl" TEXT,
    "analysis" JSONB,
    "script" TEXT,
    "attachedKbIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ttsMode" TEXT,
    "audioUrl" TEXT,
    "audioObjectKey" TEXT,
    "audioDurationSec" INTEGER NOT NULL DEFAULT 0,
    "avatarId" TEXT,
    "bgmPresetId" TEXT,
    "bgmObjectKey" TEXT,
    "bgmVolume" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "resultVideoUrl" TEXT,
    "resultObjectKey" TEXT,
    "finalVideoUrl" TEXT,
    "finalObjectKey" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DubProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DubBgmPreset" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DubBgmPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DubProject_userId_createdAt_idx" ON "DubProject"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DubProject_userId_stage_idx" ON "DubProject"("userId", "stage");

-- CreateIndex
CREATE INDEX "DubBgmPreset_enabled_sortOrder_idx" ON "DubBgmPreset"("enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "SkyhumanTask_projectId_idx" ON "SkyhumanTask"("projectId");

-- AddForeignKey
ALTER TABLE "DubProject" ADD CONSTRAINT "DubProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
