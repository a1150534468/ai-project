-- 文本 reserve 的 operationId 此前只存在于运行时内存，进程崩溃即无人退款，
-- 项目也永远卡在 generating/revising。落库后由 article-workflow-reaper 收尸退款。
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "billingOperationId" TEXT;
