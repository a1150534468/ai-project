-- Switch all semantic-vector stores from the retired 4096-dimensional model
-- to Bailian text-embedding-v4 at 1024 dimensions.
--
-- Vector rows are derived data. Keep source documents/projects, discard only
-- derived vectors, and mark knowledge-base documents for re-indexing.
TRUNCATE TABLE "Memory", "Chunk", "NovelVectorMemory";

UPDATE "Document"
SET status = 'pending',
    error = NULL,
    "chunkCount" = 0,
    "tokensUsed" = 0,
    "lockedBy" = NULL,
    "lockedAt" = NULL,
    attempts = 0;

ALTER TABLE "Memory"
  ALTER COLUMN embedding TYPE vector(1024);

ALTER TABLE "Chunk"
  ALTER COLUMN embedding TYPE vector(1024);

ALTER TABLE "NovelVectorMemory"
  ALTER COLUMN embedding TYPE vector(1024);

-- 1024 dimensions are below pgvector's 2000-dimension ANN index limit.
CREATE INDEX "Memory_embedding_hnsw_idx"
  ON "Memory" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX "Chunk_embedding_hnsw_idx"
  ON "Chunk" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX "NovelVectorMemory_embedding_hnsw_idx"
  ON "NovelVectorMemory" USING hnsw (embedding vector_cosine_ops);
