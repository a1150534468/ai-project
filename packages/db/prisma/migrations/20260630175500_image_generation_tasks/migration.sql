CREATE TABLE "ImageGenerationTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "size" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "completedCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImageGenerationTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageGenerationTask_requestId_key" ON "ImageGenerationTask"("requestId");
CREATE INDEX "ImageGenerationTask_userId_createdAt_idx" ON "ImageGenerationTask"("userId", "createdAt");
CREATE INDEX "ImageGenerationTask_status_updatedAt_idx" ON "ImageGenerationTask"("status", "updatedAt");

ALTER TABLE "ImageGenerationTask"
  ADD CONSTRAINT "ImageGenerationTask_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
