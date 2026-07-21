ALTER TABLE "CodexPetProject"
  ADD COLUMN "imageModel" TEXT NOT NULL DEFAULT 'gpt-image-2',
  ADD COLUMN "visualQaModel" TEXT NOT NULL DEFAULT 'gpt-5.6-sol';

ALTER TABLE "CodexPetRun"
  ADD COLUMN "visualQaModel" TEXT NOT NULL DEFAULT 'gpt-5.6-sol';
