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

CREATE UNIQUE INDEX "TryOnReferenceAsset_objectKey_key" ON "TryOnReferenceAsset"("objectKey");
CREATE INDEX "TryOnReferenceAsset_userId_kind_createdAt_idx" ON "TryOnReferenceAsset"("userId", "kind", "createdAt");
CREATE INDEX "TryOnReferenceAsset_expiresAt_deletedAt_idx" ON "TryOnReferenceAsset"("expiresAt", "deletedAt");
CREATE UNIQUE INDEX "TryOnTask_requestId_key" ON "TryOnTask"("requestId");
CREATE UNIQUE INDEX "TryOnTask_billingOperationId_key" ON "TryOnTask"("billingOperationId");
CREATE INDEX "TryOnTask_userId_createdAt_idx" ON "TryOnTask"("userId", "createdAt");
CREATE INDEX "TryOnTask_status_updatedAt_idx" ON "TryOnTask"("status", "updatedAt");
CREATE UNIQUE INDEX "TryOnOutput_objectKey_key" ON "TryOnOutput"("objectKey");
CREATE UNIQUE INDEX "TryOnOutput_taskId_requestIndex_key" ON "TryOnOutput"("taskId", "requestIndex");
CREATE INDEX "TryOnOutput_userId_createdAt_idx" ON "TryOnOutput"("userId", "createdAt");

ALTER TABLE "TryOnReferenceAsset" ADD CONSTRAINT "TryOnReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TryOnTask" ADD CONSTRAINT "TryOnTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TryOnOutput" ADD CONSTRAINT "TryOnOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TryOnTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TryOnOutput" ADD CONSTRAINT "TryOnOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
