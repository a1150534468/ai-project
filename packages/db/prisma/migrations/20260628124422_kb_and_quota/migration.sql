-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "attachedKbIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "kbAttachAllOwn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUri" TEXT,
    "mime" TEXT,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "opId" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(4096) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbQuotaPackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL DEFAULT 0,
    "pricePoints" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbQuotaPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbQuotaGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "opId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbQuotaGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeBase_userId_idx" ON "KnowledgeBase"("userId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_ownerType_idx" ON "KnowledgeBase"("ownerType");

-- CreateIndex
CREATE INDEX "Document_kbId_idx" ON "Document"("kbId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Chunk_kbId_idx" ON "Chunk"("kbId");

-- CreateIndex
CREATE INDEX "Chunk_documentId_idx" ON "Chunk"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "KbQuotaGrant_opId_key" ON "KbQuotaGrant"("opId");

-- CreateIndex
CREATE INDEX "KbQuotaGrant_userId_idx" ON "KbQuotaGrant"("userId");

-- CreateIndex
CREATE INDEX "KbQuotaGrant_expiresAt_idx" ON "KbQuotaGrant"("expiresAt");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: pgvector indices (HNSW/IVFFlat) support max 2000 dimensions
-- For 4096-dim embeddings, use pg_sphere or application-level vector search
-- Index will be added in a future optimization task when dimensionality is reduced or pg_sphere is integrated
