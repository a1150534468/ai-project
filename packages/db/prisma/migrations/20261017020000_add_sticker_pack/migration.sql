-- 表情包工坊：StickerPack（贴纸本身复用 ImageAsset，按 requestId 聚合）
CREATE TABLE "StickerPack" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "characterPrompt" TEXT NOT NULL,
  "style" TEXT NOT NULL DEFAULT 'cute',
  "referenceObjectKey" TEXT,
  "baseImageRequestId" TEXT,
  "presetKeys" TEXT[] NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "completedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StickerPack_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StickerPack_requestId_key" ON "StickerPack"("requestId");
CREATE INDEX "StickerPack_userId_createdAt_idx" ON "StickerPack"("userId", "createdAt");
CREATE INDEX "StickerPack_status_updatedAt_idx" ON "StickerPack"("status", "updatedAt");
ALTER TABLE "StickerPack" ADD CONSTRAINT "StickerPack_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
