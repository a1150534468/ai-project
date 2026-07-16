-- Preserve the exact model request sent for every generation attempt.
CREATE TABLE "NovelGenerationRequest" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT,
  "chapterIndex" INTEGER,
  "taskId" TEXT NOT NULL,
  "runId" TEXT,
  "stepId" TEXT,
  "targetKind" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "systemPrompt" TEXT NOT NULL,
  "userPrompt" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "temperature" DOUBLE PRECISION,
  "maxTokens" INTEGER NOT NULL,
  "templateId" TEXT,
  "templateVersion" INTEGER,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'submitted',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelGenerationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NovelGenerationRequest_taskId_key" ON "NovelGenerationRequest"("taskId");
CREATE INDEX "NovelGenerationRequest_projectId_chapterIndex_createdAt_idx" ON "NovelGenerationRequest"("projectId", "chapterIndex", "createdAt");
CREATE INDEX "NovelGenerationRequest_chapterId_createdAt_idx" ON "NovelGenerationRequest"("chapterId", "createdAt");
CREATE INDEX "NovelGenerationRequest_runId_createdAt_idx" ON "NovelGenerationRequest"("runId", "createdAt");

ALTER TABLE "NovelGenerationRequest" ADD CONSTRAINT "NovelGenerationRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelGenerationRequest" ADD CONSTRAINT "NovelGenerationRequest_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "NovelChapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NovelGenerationRequest" ADD CONSTRAINT "NovelGenerationRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "NovelTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add durable lifecycle metadata and evidence events for narrative ledgers.
ALTER TABLE "NovelForeshadowItem"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "sourceKey" TEXT,
  ADD COLUMN "lastMentionedChapter" INTEGER,
  ADD COLUMN "resolvedInChapterIndex" INTEGER,
  ADD COLUMN "resolutionEvidence" TEXT NOT NULL DEFAULT '';

ALTER TABLE "NovelNarrativeDebt"
  ADD COLUMN "foreshadowId" TEXT,
  ADD COLUMN "resolvedInChapter" INTEGER,
  ADD COLUMN "resolutionEvidence" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "sourceKey" TEXT;

-- Existing paired openThread rows came from the old automatic extractor.
UPDATE "NovelForeshadowItem" f SET "source" = 'legacyAuto', "sourceKey" = 'legacy:' || f."id"
WHERE EXISTS (
  SELECT 1 FROM "NovelNarrativeDebt" d
  WHERE d."projectId" = f."projectId"
    AND d."debtType" = 'openThread'
    AND d."title" = f."title"
    AND d."introducedChapter" IS NOT DISTINCT FROM f."introducedInChapterIndex"
);

UPDATE "NovelNarrativeDebt" d SET "source" = 'legacyAuto', "sourceKey" = 'legacy:' || d."id"
WHERE d."debtType" = 'openThread'
  AND EXISTS (
    SELECT 1 FROM "NovelForeshadowItem" f
    WHERE f."projectId" = d."projectId"
      AND f."title" = d."title"
      AND f."introducedInChapterIndex" IS NOT DISTINCT FROM d."introducedChapter"
  );

CREATE UNIQUE INDEX "NovelForeshadowItem_projectId_sourceKey_key" ON "NovelForeshadowItem"("projectId", "sourceKey");
CREATE UNIQUE INDEX "NovelNarrativeDebt_projectId_sourceKey_key" ON "NovelNarrativeDebt"("projectId", "sourceKey");
CREATE INDEX "NovelNarrativeDebt_foreshadowId_idx" ON "NovelNarrativeDebt"("foreshadowId");
ALTER TABLE "NovelNarrativeDebt" ADD CONSTRAINT "NovelNarrativeDebt_foreshadowId_fkey" FOREIGN KEY ("foreshadowId") REFERENCES "NovelForeshadowItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "NovelForeshadowEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "foreshadowId" TEXT NOT NULL,
  "chapterId" TEXT,
  "chapterIndex" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "evidence" TEXT NOT NULL DEFAULT '',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "source" TEXT NOT NULL DEFAULT 'chapterPostprocess',
  "sourceKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelForeshadowEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NovelForeshadowEvent_projectId_sourceKey_key" ON "NovelForeshadowEvent"("projectId", "sourceKey");
CREATE INDEX "NovelForeshadowEvent_foreshadowId_chapterIndex_idx" ON "NovelForeshadowEvent"("foreshadowId", "chapterIndex");
CREATE INDEX "NovelForeshadowEvent_projectId_chapterIndex_idx" ON "NovelForeshadowEvent"("projectId", "chapterIndex");
ALTER TABLE "NovelForeshadowEvent" ADD CONSTRAINT "NovelForeshadowEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelForeshadowEvent" ADD CONSTRAINT "NovelForeshadowEvent_foreshadowId_fkey" FOREIGN KEY ("foreshadowId") REFERENCES "NovelForeshadowItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelForeshadowEvent" ADD CONSTRAINT "NovelForeshadowEvent_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "NovelChapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
