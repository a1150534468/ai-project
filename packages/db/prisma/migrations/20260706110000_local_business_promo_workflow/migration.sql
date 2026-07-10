-- CreateTable
CREATE TABLE "LocalBusinessPromoProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '未命名宣传项目',
    "brief" JSONB NOT NULL DEFAULT '{}',
    "materials" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "scriptDraft" TEXT NOT NULL DEFAULT '',
    "latestRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalBusinessPromoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalBusinessPromoRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "settingsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "scriptSnapshot" TEXT NOT NULL DEFAULT '',
    "shotPlan" JSONB NOT NULL DEFAULT '[]',
    "clipRequestIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mergedAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LocalBusinessPromoRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocalBusinessPromoProject_userId_updatedAt_idx" ON "LocalBusinessPromoProject"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoProject_userId_status_idx" ON "LocalBusinessPromoProject"("userId", "status");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoRun_projectId_createdAt_idx" ON "LocalBusinessPromoRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoRun_userId_updatedAt_idx" ON "LocalBusinessPromoRun"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "LocalBusinessPromoRun_status_updatedAt_idx" ON "LocalBusinessPromoRun"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoProject" ADD CONSTRAINT "LocalBusinessPromoProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoRun" ADD CONSTRAINT "LocalBusinessPromoRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "LocalBusinessPromoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalBusinessPromoRun" ADD CONSTRAINT "LocalBusinessPromoRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
