CREATE TABLE "ArticleWorkflowProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "templateKey" TEXT NOT NULL DEFAULT 'product-seeding',
    "docJson" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "progressStage" TEXT NOT NULL DEFAULT 'draft',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleWorkflowProject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ArticleWorkflowProject_userId_updatedAt_idx" ON "ArticleWorkflowProject"("userId", "updatedAt");
CREATE INDEX "ArticleWorkflowProject_userId_status_idx" ON "ArticleWorkflowProject"("userId", "status");

ALTER TABLE "ArticleWorkflowProject" ADD CONSTRAINT "ArticleWorkflowProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
