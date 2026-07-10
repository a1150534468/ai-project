CREATE TABLE "EcomWorkflow" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "product" JSONB NOT NULL,
  "referenceAssetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "masterAssetId" TEXT,
  "segments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "stitchedAssetId" TEXT,
  "stage" TEXT NOT NULL DEFAULT 'draft',
  "error" TEXT,
  "billingOperationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EcomWorkflow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EcomWorkflow_userId_createdAt_idx" ON "EcomWorkflow"("userId", "createdAt");
CREATE INDEX "EcomWorkflow_userId_stage_idx" ON "EcomWorkflow"("userId", "stage");

ALTER TABLE "EcomWorkflow"
  ADD CONSTRAINT "EcomWorkflow_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
