-- 一次导入 = 同 batchId 的 N 行，每行一个平台、一个独立生成单元与一笔独立 reserve。
-- 存量行默认 wechat、batchId 为空（读路径视为单平台独立批次），不回填。
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'wechat';
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "batchId" TEXT;
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "captionText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "tagsJson" JSONB NOT NULL DEFAULT '[]';
CREATE INDEX "ArticleWorkflowProject_userId_batchId_idx" ON "ArticleWorkflowProject"("userId", "batchId");
