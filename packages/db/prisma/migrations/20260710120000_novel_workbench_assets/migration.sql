ALTER TABLE "NovelChapter"
ADD COLUMN "rawContent" TEXT NOT NULL DEFAULT '',
ADD COLUMN "openThreads" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "contextSnapshot" JSONB,
ADD COLUMN "generationMeta" JSONB,
ADD COLUMN "consistencyJson" JSONB,
ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "reviewNotes" TEXT NOT NULL DEFAULT '',
ADD COLUMN "aiReview" TEXT NOT NULL DEFAULT '',
ADD COLUMN "aiActionItems" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "modificationRate" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE TABLE "NovelKnowledgeFact" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT,
  "chapterIndex" INTEGER,
  "subject" TEXT NOT NULL,
  "predicate" TEXT NOT NULL,
  "object" TEXT NOT NULL,
  "sourceExcerpt" TEXT NOT NULL DEFAULT '',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "status" TEXT NOT NULL DEFAULT 'confirmed',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelKnowledgeFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelForeshadowItem" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "introducedInChapterId" TEXT,
  "introducedInChapterIndex" INTEGER,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "expectedPayoffChapter" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'open',
  "relatedCharacter" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelForeshadowItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NovelChapter_projectId_reviewStatus_idx" ON "NovelChapter"("projectId", "reviewStatus");
CREATE UNIQUE INDEX "NovelKnowledgeFact_projectId_chapterIndex_subject_predicate_object_key" ON "NovelKnowledgeFact"("projectId", "chapterIndex", "subject", "predicate", "object");
CREATE INDEX "NovelKnowledgeFact_projectId_status_idx" ON "NovelKnowledgeFact"("projectId", "status");
CREATE INDEX "NovelKnowledgeFact_projectId_updatedAt_idx" ON "NovelKnowledgeFact"("projectId", "updatedAt");
CREATE UNIQUE INDEX "NovelForeshadowItem_projectId_title_key" ON "NovelForeshadowItem"("projectId", "title");
CREATE INDEX "NovelForeshadowItem_projectId_status_idx" ON "NovelForeshadowItem"("projectId", "status");
CREATE INDEX "NovelForeshadowItem_projectId_expectedPayoffChapter_idx" ON "NovelForeshadowItem"("projectId", "expectedPayoffChapter");

ALTER TABLE "NovelKnowledgeFact"
ADD CONSTRAINT "NovelKnowledgeFact_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelForeshadowItem"
ADD CONSTRAINT "NovelForeshadowItem_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
