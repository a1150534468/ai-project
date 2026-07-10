-- AlterTable
ALTER TABLE "LocalBusinessPromoRun"
ADD COLUMN     "analysisSnapshot" JSONB,
ADD COLUMN     "narrationAssetId" TEXT,
ADD COLUMN     "bgmAssetId" TEXT,
ADD COLUMN     "progressPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "progressStage" TEXT NOT NULL DEFAULT 'queued',
ADD COLUMN     "progressMessage" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "workerId" TEXT;
