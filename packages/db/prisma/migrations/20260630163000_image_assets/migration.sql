CREATE TABLE "ImageAsset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestIndex" INTEGER NOT NULL,
  "prompt" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "size" TEXT NOT NULL,
  "originalUrl" TEXT NOT NULL,
  "thumbnailUrl" TEXT NOT NULL,
  "objectKey" TEXT,
  "mime" TEXT NOT NULL DEFAULT 'image/png',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageAsset_requestId_requestIndex_key" ON "ImageAsset"("requestId", "requestIndex");
CREATE INDEX "ImageAsset_userId_createdAt_idx" ON "ImageAsset"("userId", "createdAt");

ALTER TABLE "ImageAsset"
  ADD CONSTRAINT "ImageAsset_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
