ALTER TABLE "ArticleWorkflowProject"
  ADD COLUMN "creationMode" TEXT NOT NULL DEFAULT 'source',
  ADD COLUMN "creationConfigJson" JSONB NOT NULL DEFAULT '{}';
