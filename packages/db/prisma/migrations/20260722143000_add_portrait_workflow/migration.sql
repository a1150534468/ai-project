-- CreateTable
CREATE TABLE "PortraitReferenceAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'image/jpeg',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortraitReferenceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortraitTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "effectivePrompt" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "referenceAssetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'running',
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "consentVersion" TEXT NOT NULL,
    "billingOperationId" TEXT NOT NULL,
    "billingResourceKey" TEXT NOT NULL,
    "billingReservedUnits" INTEGER NOT NULL DEFAULT 0,
    "billingSettledUnits" INTEGER NOT NULL DEFAULT 0,
    "billingStatus" TEXT NOT NULL DEFAULT 'pending',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortraitTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortraitOutput" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestIndex" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'image/png',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortraitOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortraitReferenceAsset_objectKey_key" ON "PortraitReferenceAsset"("objectKey");
CREATE INDEX "PortraitReferenceAsset_userId_createdAt_idx" ON "PortraitReferenceAsset"("userId", "createdAt");
CREATE INDEX "PortraitReferenceAsset_expiresAt_deletedAt_idx" ON "PortraitReferenceAsset"("expiresAt", "deletedAt");
CREATE UNIQUE INDEX "PortraitTask_requestId_key" ON "PortraitTask"("requestId");
CREATE UNIQUE INDEX "PortraitTask_billingOperationId_key" ON "PortraitTask"("billingOperationId");
CREATE INDEX "PortraitTask_userId_createdAt_idx" ON "PortraitTask"("userId", "createdAt");
CREATE INDEX "PortraitTask_status_updatedAt_idx" ON "PortraitTask"("status", "updatedAt");
CREATE UNIQUE INDEX "PortraitOutput_objectKey_key" ON "PortraitOutput"("objectKey");
CREATE UNIQUE INDEX "PortraitOutput_taskId_requestIndex_key" ON "PortraitOutput"("taskId", "requestIndex");
CREATE INDEX "PortraitOutput_userId_createdAt_idx" ON "PortraitOutput"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PortraitReferenceAsset" ADD CONSTRAINT "PortraitReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortraitTask" ADD CONSTRAINT "PortraitTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortraitOutput" ADD CONSTRAINT "PortraitOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PortraitTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortraitOutput" ADD CONSTRAINT "PortraitOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
