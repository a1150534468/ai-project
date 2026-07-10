CREATE TABLE "NovelProject" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "genre" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelSection" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'empty',
  "displayText" TEXT NOT NULL DEFAULT '',
  "structuredJson" JSONB,
  "billableChars" INTEGER NOT NULL DEFAULT 0,
  "lastTaskId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelSectionVersion" (
  "id" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "displayText" TEXT NOT NULL,
  "structuredJson" JSONB,
  "billableChars" INTEGER NOT NULL DEFAULT 0,
  "operationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NovelSectionVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelChapter" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "volumeIndex" INTEGER NOT NULL DEFAULT 1,
  "chapterIndex" INTEGER NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "billableChars" INTEGER NOT NULL DEFAULT 0,
  "lastTaskId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NovelChapter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelChapterVersion" (
  "id" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL,
  "billableChars" INTEGER NOT NULL DEFAULT 0,
  "operationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NovelChapterVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelTask" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requestPayload" JSONB,
  "resultPayload" JSONB,
  "operationId" TEXT NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "NovelTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NovelProject_userId_updatedAt_idx" ON "NovelProject"("userId", "updatedAt");

CREATE UNIQUE INDEX "NovelSection_projectId_kind_key" ON "NovelSection"("projectId", "kind");
CREATE INDEX "NovelSection_projectId_updatedAt_idx" ON "NovelSection"("projectId", "updatedAt");

CREATE INDEX "NovelSectionVersion_sectionId_createdAt_idx" ON "NovelSectionVersion"("sectionId", "createdAt");

CREATE UNIQUE INDEX "NovelChapter_projectId_chapterIndex_key" ON "NovelChapter"("projectId", "chapterIndex");
CREATE INDEX "NovelChapter_projectId_updatedAt_idx" ON "NovelChapter"("projectId", "updatedAt");

CREATE INDEX "NovelChapterVersion_chapterId_createdAt_idx" ON "NovelChapterVersion"("chapterId", "createdAt");

CREATE UNIQUE INDEX "NovelTask_operationId_key" ON "NovelTask"("operationId");
CREATE INDEX "NovelTask_userId_updatedAt_idx" ON "NovelTask"("userId", "updatedAt");
CREATE INDEX "NovelTask_projectId_updatedAt_idx" ON "NovelTask"("projectId", "updatedAt");
CREATE INDEX "NovelTask_status_updatedAt_idx" ON "NovelTask"("status", "updatedAt");

ALTER TABLE "NovelProject"
  ADD CONSTRAINT "NovelProject_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelSection"
  ADD CONSTRAINT "NovelSection_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelSectionVersion"
  ADD CONSTRAINT "NovelSectionVersion_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "NovelSection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelChapter"
  ADD CONSTRAINT "NovelChapter_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelChapterVersion"
  ADD CONSTRAINT "NovelChapterVersion_chapterId_fkey"
  FOREIGN KEY ("chapterId") REFERENCES "NovelChapter"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelTask"
  ADD CONSTRAINT "NovelTask_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelTask"
  ADD CONSTRAINT "NovelTask_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
