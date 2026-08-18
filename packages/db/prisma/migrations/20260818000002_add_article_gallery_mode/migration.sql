-- 配图画廊布局模式：collage（拼贴，默认）/ grid（网格）/ stack（单列）
-- caption 平台（小红书/抖音）无正文画廊，恒用默认 collage
ALTER TABLE "ArticleWorkflowProject" ADD COLUMN "galleryMode" TEXT NOT NULL DEFAULT 'collage';
