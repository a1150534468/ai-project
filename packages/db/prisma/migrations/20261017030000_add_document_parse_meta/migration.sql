-- RAG 解析质量追踪：Document.parseMeta（JSONB，可空）
ALTER TABLE "Document" ADD COLUMN "parseMeta" JSONB;
