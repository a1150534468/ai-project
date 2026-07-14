-- A vector can only be rebuilt when the original object/URL still exists.
-- Keep the document metadata for visibility, but expose an actionable status
-- instead of repeatedly sending an empty object key to S3.
UPDATE "Document"
SET status = 'failed',
    error = '原始文档内容缺失，无法重建向量，请重新上传该文档',
    "chunkCount" = 0,
    "tokensUsed" = 0,
    "lockedBy" = NULL,
    "lockedAt" = NULL,
    attempts = 0
WHERE "sourceUri" IS NULL;
