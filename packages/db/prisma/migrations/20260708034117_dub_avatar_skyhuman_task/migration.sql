-- CreateTable
CREATE TABLE "Avatar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "avatarCode" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '未命名',
    "coverUrl" TEXT,
    "sourceObjectKey" TEXT,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Avatar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkyhumanTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "avatarId" TEXT,
    "providerTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "resourceKey" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "chargedPoints" INTEGER NOT NULL DEFAULT 0,
    "audioObjectKey" TEXT,
    "title" TEXT NOT NULL DEFAULT '未命名',
    "resultPayload" JSONB,
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkyhumanTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Avatar_userId_createdAt_idx" ON "Avatar"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkyhumanTask_operationId_key" ON "SkyhumanTask"("operationId");

-- CreateIndex
CREATE INDEX "SkyhumanTask_status_updatedAt_idx" ON "SkyhumanTask"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SkyhumanTask_providerTaskId_idx" ON "SkyhumanTask"("providerTaskId");

-- CreateIndex
CREATE INDEX "SkyhumanTask_userId_createdAt_idx" ON "SkyhumanTask"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Avatar" ADD CONSTRAINT "Avatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkyhumanTask" ADD CONSTRAINT "SkyhumanTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
