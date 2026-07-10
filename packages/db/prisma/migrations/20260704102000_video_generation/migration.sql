CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestIndex" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "objectKey" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'video/mp4',
    "format" TEXT NOT NULL DEFAULT 'mp4',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VideoGenerationTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "generateAudio" BOOLEAN NOT NULL DEFAULT true,
    "hasInputVideo" BOOLEAN NOT NULL DEFAULT false,
    "resourceKey" TEXT NOT NULL,
    "chargedPoints" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "resultPayload" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoGenerationTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VideoAsset_requestId_requestIndex_key" ON "VideoAsset"("requestId", "requestIndex");
CREATE INDEX "VideoAsset_userId_createdAt_idx" ON "VideoAsset"("userId", "createdAt");

CREATE UNIQUE INDEX "VideoGenerationTask_requestId_key" ON "VideoGenerationTask"("requestId");
CREATE INDEX "VideoGenerationTask_userId_createdAt_idx" ON "VideoGenerationTask"("userId", "createdAt");
CREATE INDEX "VideoGenerationTask_status_updatedAt_idx" ON "VideoGenerationTask"("status", "updatedAt");
CREATE INDEX "VideoGenerationTask_providerTaskId_idx" ON "VideoGenerationTask"("providerTaskId");

ALTER TABLE "VideoAsset"
ADD CONSTRAINT "VideoAsset_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VideoGenerationTask"
ADD CONSTRAINT "VideoGenerationTask_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
