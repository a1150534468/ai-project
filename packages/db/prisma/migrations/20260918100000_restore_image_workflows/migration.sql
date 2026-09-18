-- Restore the entire image module without modifying any existing table or historical migration.
-- Legacy billing columns are retained for compatibility, not connected to a billing service.
BEGIN;

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
    "referenceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
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

-- CreateTable
CREATE TABLE "TryOnReferenceAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'image/jpeg',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TryOnReferenceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TryOnTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "effectivePrompt" TEXT NOT NULL,
    "garmentFrontAssetId" TEXT NOT NULL,
    "garmentDetailAssetId" TEXT,
    "modelAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "consentVersion" TEXT,
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

    CONSTRAINT "TryOnTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TryOnOutput" (
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

    CONSTRAINT "TryOnOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomWorkflow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT '1K',
    "model" TEXT,
    "segmentCount" INTEGER NOT NULL DEFAULT 3,
    "product" JSONB NOT NULL,
    "referenceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "masterAssetId" TEXT,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "stitchedAssetId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "billingOperationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomMainImageJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "ratio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT '1K',
    "model" TEXT,
    "style" TEXT NOT NULL,
    "customStyle" TEXT NOT NULL DEFAULT '',
    "withText" BOOLEAN NOT NULL DEFAULT true,
    "product" JSONB NOT NULL,
    "referenceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "count" INTEGER NOT NULL,
    "images" JSONB NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "billingOperationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomMainImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortraitReferenceAsset_objectKey_key" ON "PortraitReferenceAsset"("objectKey");

-- CreateIndex
CREATE INDEX "PortraitReferenceAsset_userId_createdAt_idx" ON "PortraitReferenceAsset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PortraitReferenceAsset_expiresAt_deletedAt_idx" ON "PortraitReferenceAsset"("expiresAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortraitTask_requestId_key" ON "PortraitTask"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PortraitTask_billingOperationId_key" ON "PortraitTask"("billingOperationId");

-- CreateIndex
CREATE INDEX "PortraitTask_userId_createdAt_idx" ON "PortraitTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PortraitTask_status_updatedAt_idx" ON "PortraitTask"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortraitOutput_objectKey_key" ON "PortraitOutput"("objectKey");

-- CreateIndex
CREATE INDEX "PortraitOutput_userId_createdAt_idx" ON "PortraitOutput"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortraitOutput_taskId_requestIndex_key" ON "PortraitOutput"("taskId", "requestIndex");

-- CreateIndex
CREATE UNIQUE INDEX "TryOnReferenceAsset_objectKey_key" ON "TryOnReferenceAsset"("objectKey");

-- CreateIndex
CREATE INDEX "TryOnReferenceAsset_userId_kind_createdAt_idx" ON "TryOnReferenceAsset"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "TryOnReferenceAsset_expiresAt_deletedAt_idx" ON "TryOnReferenceAsset"("expiresAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TryOnTask_requestId_key" ON "TryOnTask"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "TryOnTask_billingOperationId_key" ON "TryOnTask"("billingOperationId");

-- CreateIndex
CREATE INDEX "TryOnTask_userId_createdAt_idx" ON "TryOnTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TryOnTask_status_updatedAt_idx" ON "TryOnTask"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TryOnOutput_objectKey_key" ON "TryOnOutput"("objectKey");

-- CreateIndex
CREATE INDEX "TryOnOutput_userId_createdAt_idx" ON "TryOnOutput"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TryOnOutput_taskId_requestIndex_key" ON "TryOnOutput"("taskId", "requestIndex");

-- CreateIndex
CREATE INDEX "EcomWorkflow_userId_createdAt_idx" ON "EcomWorkflow"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomWorkflow_userId_stage_idx" ON "EcomWorkflow"("userId", "stage");

-- CreateIndex
CREATE INDEX "EcomMainImageJob_userId_createdAt_idx" ON "EcomMainImageJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomMainImageJob_userId_stage_idx" ON "EcomMainImageJob"("userId", "stage");

-- AddForeignKey
ALTER TABLE "PortraitReferenceAsset" ADD CONSTRAINT "PortraitReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortraitTask" ADD CONSTRAINT "PortraitTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortraitOutput" ADD CONSTRAINT "PortraitOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PortraitTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortraitOutput" ADD CONSTRAINT "PortraitOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOnReferenceAsset" ADD CONSTRAINT "TryOnReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOnTask" ADD CONSTRAINT "TryOnTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOnOutput" ADD CONSTRAINT "TryOnOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TryOnTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TryOnOutput" ADD CONSTRAINT "TryOnOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomWorkflow" ADD CONSTRAINT "EcomWorkflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomMainImageJob" ADD CONSTRAINT "EcomMainImageJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
