ALTER TABLE "NovelTask"
  ADD COLUMN "progressPercent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progressStage" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN "progressMessage" TEXT,
  ADD COLUMN "progressPreview" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "streamedChars" INTEGER NOT NULL DEFAULT 0;
