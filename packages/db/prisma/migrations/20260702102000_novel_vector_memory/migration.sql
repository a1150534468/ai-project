CREATE TABLE "NovelVectorMemory" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "embedding" vector(4096) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelVectorMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NovelVectorMemory_projectId_sourceType_sourceId_key"
  ON "NovelVectorMemory"("projectId", "sourceType", "sourceId");

CREATE INDEX "NovelVectorMemory_projectId_sourceKind_idx"
  ON "NovelVectorMemory"("projectId", "sourceKind");

CREATE INDEX "NovelVectorMemory_projectId_updatedAt_idx"
  ON "NovelVectorMemory"("projectId", "updatedAt");

ALTER TABLE "NovelVectorMemory"
  ADD CONSTRAINT "NovelVectorMemory_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
