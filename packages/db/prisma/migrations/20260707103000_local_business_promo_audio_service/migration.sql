-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "requestId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "providerModel" TEXT,
    "originalUrl" TEXT NOT NULL,
    "objectKey" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'audio/wav',
    "format" TEXT NOT NULL DEFAULT 'wav',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "textContent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioGenerationTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "providerModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "inputPayload" JSONB,
    "resultPayload" JSONB,
    "assetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AudioGenerationTask_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "LocalBusinessPromoProject"
ADD COLUMN     "voiceCloneSampleAssetId" TEXT,
ADD COLUMN     "activeNarrationAssetId" TEXT,
ADD COLUMN     "activeBgmAssetId" TEXT;

-- CreateIndex
CREATE INDEX "AudioAsset_userId_createdAt_idx" ON "AudioAsset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioAsset_projectId_createdAt_idx" ON "AudioAsset"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioAsset_userId_kind_createdAt_idx" ON "AudioAsset"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AudioAsset_requestId_idx" ON "AudioAsset"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioGenerationTask_requestId_key" ON "AudioGenerationTask"("requestId");

-- CreateIndex
CREATE INDEX "AudioGenerationTask_userId_createdAt_idx" ON "AudioGenerationTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioGenerationTask_projectId_createdAt_idx" ON "AudioGenerationTask"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AudioGenerationTask_status_updatedAt_idx" ON "AudioGenerationTask"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoProject_voiceCloneSampleAssetId_idx" ON "LocalBusinessPromoProject"("voiceCloneSampleAssetId");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoProject_activeNarrationAssetId_idx" ON "LocalBusinessPromoProject"("activeNarrationAssetId");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoProject_activeBgmAssetId_idx" ON "LocalBusinessPromoProject"("activeBgmAssetId");

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "LocalBusinessPromoProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationTask" ADD CONSTRAINT "AudioGenerationTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationTask" ADD CONSTRAINT "AudioGenerationTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "LocalBusinessPromoProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationTask" ADD CONSTRAINT "AudioGenerationTask_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoProject" ADD CONSTRAINT "LocalBusinessPromoProject_voiceCloneSampleAssetId_fkey" FOREIGN KEY ("voiceCloneSampleAssetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoProject" ADD CONSTRAINT "LocalBusinessPromoProject_activeNarrationAssetId_fkey" FOREIGN KEY ("activeNarrationAssetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoProject" ADD CONSTRAINT "LocalBusinessPromoProject_activeBgmAssetId_fkey" FOREIGN KEY ("activeBgmAssetId") REFERENCES "AudioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
