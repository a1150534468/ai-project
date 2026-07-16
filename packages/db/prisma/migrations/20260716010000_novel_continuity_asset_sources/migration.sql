ALTER TABLE "NovelTimelineEvent"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "sourceKey" TEXT;

ALTER TABLE "NovelProp"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "NovelPropEvent"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "NovelTimelineEvent_projectId_sourceKey_key"
ON "NovelTimelineEvent"("projectId", "sourceKey");

CREATE UNIQUE INDEX "NovelPropEvent_projectId_sourceKey_key"
ON "NovelPropEvent"("projectId", "sourceKey");
