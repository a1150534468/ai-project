ALTER TABLE "Memory"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "lastUsedAt" TIMESTAMP(3),
  ADD COLUMN "usedCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "Memory"
SET "title" = LEFT("text", 18)
WHERE "title" = '';

CREATE INDEX "Memory_userId_type_idx" ON "Memory"("userId", "type");
