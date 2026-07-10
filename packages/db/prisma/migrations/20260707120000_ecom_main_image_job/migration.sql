-- CreateTable
CREATE TABLE "EcomMainImageJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "ratio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT '1K',
    "style" TEXT NOT NULL,
    "customStyle" TEXT NOT NULL DEFAULT '',
    "product" JSONB NOT NULL,
    "referenceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "count" INTEGER NOT NULL,
    "images" JSONB NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "billingOperationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomMainImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EcomMainImageJob_userId_createdAt_idx" ON "EcomMainImageJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomMainImageJob_userId_stage_idx" ON "EcomMainImageJob"("userId", "stage");

-- AddForeignKey
ALTER TABLE "EcomMainImageJob" ADD CONSTRAINT "EcomMainImageJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
