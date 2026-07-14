-- These setup resources were added to an already-applied novel engine migration.
-- Use idempotent DDL so databases created from the amended original migration
-- and databases that ran its earlier form both converge on the same schema.
CREATE TABLE IF NOT EXISTS "NovelBible" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "premiseLock" TEXT NOT NULL DEFAULT '',
  "genreLock" TEXT NOT NULL DEFAULT '',
  "worldPresetLock" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelBible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NovelWorldDimension" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "bibleId" TEXT NOT NULL,
  "dimensionKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "details" JSONB NOT NULL DEFAULT '{}',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelWorldDimension_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NovelStyleNote" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "bibleId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelStyleNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NovelBible_projectId_key"
  ON "NovelBible"("projectId");
CREATE INDEX IF NOT EXISTS "NovelWorldDimension_bibleId_position_idx"
  ON "NovelWorldDimension"("bibleId", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "NovelWorldDimension_projectId_dimensionKey_key"
  ON "NovelWorldDimension"("projectId", "dimensionKey");
CREATE INDEX IF NOT EXISTS "NovelStyleNote_bibleId_position_idx"
  ON "NovelStyleNote"("bibleId", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "NovelStyleNote_projectId_category_title_key"
  ON "NovelStyleNote"("projectId", "category", "title");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NovelBible_projectId_fkey'
      AND conrelid = '"NovelBible"'::regclass
  ) THEN
    ALTER TABLE "NovelBible"
      ADD CONSTRAINT "NovelBible_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NovelWorldDimension_projectId_fkey'
      AND conrelid = '"NovelWorldDimension"'::regclass
  ) THEN
    ALTER TABLE "NovelWorldDimension"
      ADD CONSTRAINT "NovelWorldDimension_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NovelWorldDimension_bibleId_fkey'
      AND conrelid = '"NovelWorldDimension"'::regclass
  ) THEN
    ALTER TABLE "NovelWorldDimension"
      ADD CONSTRAINT "NovelWorldDimension_bibleId_fkey"
      FOREIGN KEY ("bibleId") REFERENCES "NovelBible"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NovelStyleNote_projectId_fkey'
      AND conrelid = '"NovelStyleNote"'::regclass
  ) THEN
    ALTER TABLE "NovelStyleNote"
      ADD CONSTRAINT "NovelStyleNote_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NovelStyleNote_bibleId_fkey'
      AND conrelid = '"NovelStyleNote"'::regclass
  ) THEN
    ALTER TABLE "NovelStyleNote"
      ADD CONSTRAINT "NovelStyleNote_bibleId_fkey"
      FOREIGN KEY ("bibleId") REFERENCES "NovelBible"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
