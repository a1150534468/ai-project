ALTER TABLE "ArticleWorkflowProject"
ADD COLUMN "generationMode" TEXT NOT NULL DEFAULT 'preserve-text',
ADD COLUMN "bodyHtml" TEXT NOT NULL DEFAULT '',
ADD COLUMN "imageManifestJson" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "ArticleWorkflowProject"
DROP COLUMN "templateKey",
DROP COLUMN "docJson";
