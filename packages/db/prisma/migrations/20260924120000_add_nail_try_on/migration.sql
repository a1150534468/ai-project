-- CreateTable
CREATE TABLE "NailTryOnReferenceAsset" (
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

    CONSTRAINT "NailTryOnReferenceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NailTryOnTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "effectivePrompt" TEXT NOT NULL,
    "handAssetId" TEXT NOT NULL,
    "nailDesignAssetId" TEXT,
    "maskObjectKey" TEXT NOT NULL,
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

    CONSTRAINT "NailTryOnTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NailTryOnOutput" (
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

    CONSTRAINT "NailTryOnOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NailTryOnReferenceAsset_objectKey_key" ON "NailTryOnReferenceAsset"("objectKey");

-- CreateIndex
CREATE INDEX "NailTryOnReferenceAsset_userId_kind_createdAt_idx" ON "NailTryOnReferenceAsset"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "NailTryOnReferenceAsset_expiresAt_deletedAt_idx" ON "NailTryOnReferenceAsset"("expiresAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NailTryOnTask_requestId_key" ON "NailTryOnTask"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "NailTryOnTask_billingOperationId_key" ON "NailTryOnTask"("billingOperationId");

-- CreateIndex
CREATE INDEX "NailTryOnTask_userId_createdAt_idx" ON "NailTryOnTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NailTryOnTask_status_updatedAt_idx" ON "NailTryOnTask"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NailTryOnOutput_objectKey_key" ON "NailTryOnOutput"("objectKey");

-- CreateIndex
CREATE INDEX "NailTryOnOutput_userId_createdAt_idx" ON "NailTryOnOutput"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NailTryOnOutput_taskId_requestIndex_key" ON "NailTryOnOutput"("taskId", "requestIndex");

-- AddForeignKey
ALTER TABLE "NailTryOnReferenceAsset" ADD CONSTRAINT "NailTryOnReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NailTryOnTask" ADD CONSTRAINT "NailTryOnTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NailTryOnOutput" ADD CONSTRAINT "NailTryOnOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "NailTryOnTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NailTryOnOutput" ADD CONSTRAINT "NailTryOnOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


