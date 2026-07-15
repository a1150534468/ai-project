ALTER TABLE "ImageGenerationTask"
  ADD COLUMN "referenceAssetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
