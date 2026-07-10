-- CreateTable
CREATE TABLE "ComicWorkflowProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "logline" TEXT NOT NULL DEFAULT '',
    "style" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentStage" TEXT NOT NULL DEFAULT 'script',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComicWorkflowBibleEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowBibleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComicWorkflowEpisode" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "episodeNo" INTEGER NOT NULL,
    "targetDurationSec" INTEGER NOT NULL DEFAULT 90,
    "currentStage" TEXT NOT NULL DEFAULT 'script',
    "scriptVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComicWorkflowScriptVersion" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "outline" TEXT NOT NULL DEFAULT '',
    "scriptText" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "prompt" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowScriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComicWorkflowAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "imageAssetId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComicWorkflowShot" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shotNo" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "dialogue" TEXT NOT NULL DEFAULT '',
    "camera" TEXT NOT NULL DEFAULT '',
    "durationSec" INTEGER NOT NULL DEFAULT 5,
    "assetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageAssetId" TEXT,
    "videoUrl" TEXT,
    "videoStatus" TEXT NOT NULL DEFAULT 'idle',
    "videoTaskId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComicWorkflowShot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComicWorkflowProject_userId_updatedAt_idx" ON "ComicWorkflowProject"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ComicWorkflowProject_userId_status_idx" ON "ComicWorkflowProject"("userId", "status");

-- CreateIndex
CREATE INDEX "ComicWorkflowBibleEntry_projectId_position_idx" ON "ComicWorkflowBibleEntry"("projectId", "position");

-- CreateIndex
CREATE INDEX "ComicWorkflowBibleEntry_userId_updatedAt_idx" ON "ComicWorkflowBibleEntry"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ComicWorkflowEpisode_projectId_episodeNo_idx" ON "ComicWorkflowEpisode"("projectId", "episodeNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowEpisode_userId_updatedAt_idx" ON "ComicWorkflowEpisode"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComicWorkflowEpisode_projectId_episodeNo_key" ON "ComicWorkflowEpisode"("projectId", "episodeNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowScriptVersion_episodeId_versionNo_idx" ON "ComicWorkflowScriptVersion"("episodeId", "versionNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowScriptVersion_projectId_updatedAt_idx" ON "ComicWorkflowScriptVersion"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "ComicWorkflowScriptVersion_userId_updatedAt_idx" ON "ComicWorkflowScriptVersion"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComicWorkflowScriptVersion_episodeId_versionNo_key" ON "ComicWorkflowScriptVersion"("episodeId", "versionNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowAsset_projectId_type_idx" ON "ComicWorkflowAsset"("projectId", "type");

-- CreateIndex
CREATE INDEX "ComicWorkflowAsset_userId_updatedAt_idx" ON "ComicWorkflowAsset"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ComicWorkflowAsset_imageAssetId_idx" ON "ComicWorkflowAsset"("imageAssetId");

-- CreateIndex
CREATE INDEX "ComicWorkflowShot_episodeId_shotNo_idx" ON "ComicWorkflowShot"("episodeId", "shotNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowShot_projectId_shotNo_idx" ON "ComicWorkflowShot"("projectId", "shotNo");

-- CreateIndex
CREATE INDEX "ComicWorkflowShot_userId_updatedAt_idx" ON "ComicWorkflowShot"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ComicWorkflowShot_imageAssetId_idx" ON "ComicWorkflowShot"("imageAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ComicWorkflowShot_episodeId_shotNo_key" ON "ComicWorkflowShot"("episodeId", "shotNo");

-- AddForeignKey
ALTER TABLE "ComicWorkflowProject" ADD CONSTRAINT "ComicWorkflowProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowBibleEntry" ADD CONSTRAINT "ComicWorkflowBibleEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicWorkflowProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowBibleEntry" ADD CONSTRAINT "ComicWorkflowBibleEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowEpisode" ADD CONSTRAINT "ComicWorkflowEpisode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicWorkflowProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowEpisode" ADD CONSTRAINT "ComicWorkflowEpisode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowEpisode" ADD CONSTRAINT "ComicWorkflowEpisode_scriptVersionId_fkey" FOREIGN KEY ("scriptVersionId") REFERENCES "ComicWorkflowScriptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" ADD CONSTRAINT "ComicWorkflowScriptVersion_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ComicWorkflowEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" ADD CONSTRAINT "ComicWorkflowScriptVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicWorkflowProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" ADD CONSTRAINT "ComicWorkflowScriptVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowAsset" ADD CONSTRAINT "ComicWorkflowAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicWorkflowProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowAsset" ADD CONSTRAINT "ComicWorkflowAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowAsset" ADD CONSTRAINT "ComicWorkflowAsset_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowShot" ADD CONSTRAINT "ComicWorkflowShot_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "ComicWorkflowEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowShot" ADD CONSTRAINT "ComicWorkflowShot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicWorkflowProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowShot" ADD CONSTRAINT "ComicWorkflowShot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComicWorkflowShot" ADD CONSTRAINT "ComicWorkflowShot_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

