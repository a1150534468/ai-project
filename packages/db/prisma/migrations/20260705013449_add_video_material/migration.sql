-- CreateTable
CREATE TABLE "VideoMaterial" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "objectKey" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'video/mp4',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoMaterial_url_key" ON "VideoMaterial"("url");

-- CreateIndex
CREATE INDEX "VideoMaterial_userId_createdAt_idx" ON "VideoMaterial"("userId", "createdAt");
