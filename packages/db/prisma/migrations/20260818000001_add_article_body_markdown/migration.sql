-- 公众号正文 Markdown 原文：确定性主题换肤的前端本地渲染输入
-- 存量 auto 项目与 caption 项目保持空串
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "bodyMarkdown" TEXT NOT NULL DEFAULT '';
