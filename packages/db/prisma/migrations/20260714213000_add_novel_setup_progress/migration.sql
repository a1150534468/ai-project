-- setupStage and setupCompleted were added to an already-applied migration.
-- Keep this repair idempotent so it works for both existing and fresh databases.
ALTER TABLE "NovelProject"
  ADD COLUMN IF NOT EXISTS "setupStage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "setupCompleted" BOOLEAN NOT NULL DEFAULT false;
