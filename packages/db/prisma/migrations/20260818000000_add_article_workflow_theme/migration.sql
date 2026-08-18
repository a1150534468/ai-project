-- 公众号排版主题与自定义主色。
-- theme 默认 auto（AI 自由发挥）；themeColor 为空 = 用主题默认主色；存量行不回填。
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "themeColor" TEXT;
