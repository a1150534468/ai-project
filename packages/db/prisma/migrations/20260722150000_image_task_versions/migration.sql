ALTER TABLE "ImageGenerationTask" ADD COLUMN "sourceImageAssetId" TEXT;
ALTER TABLE "ImageGenerationTask" ADD COLUMN "generationIntent" TEXT NOT NULL DEFAULT 'new';
