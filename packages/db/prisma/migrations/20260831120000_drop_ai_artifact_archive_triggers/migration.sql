-- P1.1 停写：删掉「AI 产物自动归档进知识库」的全套 Postgres 触发器与函数。
--
-- 决策见 docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md：
-- AI 产物不再落知识库。知识库回到「官方 + 个人自建」，可复用媒体走素材库读模型。
--
-- 这一个迁移即消灭：
--   H1 归档失败连带业务写入回滚（12 个 plpgsql 函数里零个 EXCEPTION）
--   H2 同一用户所有产物串行化在单行 KnowledgeBase 上（ensure_ai_artifacts_kb 的
--      ON CONFLICT DO UPDATE SET updatedAt = 自身，是纯拿写锁的空写）
--   H4 用户被强开一个自己没要求过的知识库
--   H5 触发器里硬编码 sizeBytes = 0，配额口径与真实体积脱节
--   H6 改一次标题就把已耗尽重试的文档打回 pending，attempts 归零
--   H7 产物文档用户不可见也删不掉
--   L1/L3/L4 见计划第一部分
--
-- 存量数据不在这里清——P2.1 单独一个迁移，那一步不可逆。

DROP TRIGGER IF EXISTS "ImageAsset_archive" ON "ImageAsset";
DROP TRIGGER IF EXISTS "VideoAsset_archive" ON "VideoAsset";
DROP TRIGGER IF EXISTS "AudioAsset_archive" ON "AudioAsset";
DROP TRIGGER IF EXISTS "NovelChapter_archive" ON "NovelChapter";
DROP TRIGGER IF EXISTS "ArticleWorkflowProject_archive" ON "ArticleWorkflowProject";
DROP TRIGGER IF EXISTS "ComicWorkflowScriptVersion_archive" ON "ComicWorkflowScriptVersion";
DROP TRIGGER IF EXISTS "LocalBusinessPromoProject_archive" ON "LocalBusinessPromoProject";
DROP TRIGGER IF EXISTS "DubProject_archive" ON "DubProject";
DROP TRIGGER IF EXISTS "AgentWorkflowRun_archive" ON "AgentWorkflowRun";
DROP TRIGGER IF EXISTS "ScheduledTaskRun_archive" ON "ScheduledTaskRun";
DROP TRIGGER IF EXISTS "User_ai_artifacts_kb" ON "User";

-- 13 个函数（计划里写的 12 少数了一个：ensure_ai_artifacts_kb 与 archive_ai_artifact
-- 是两个公共函数，另有 10 个触发器函数 + 1 个用户开库触发器函数）。
DROP FUNCTION IF EXISTS archive_image_asset_trigger();
DROP FUNCTION IF EXISTS archive_video_asset_trigger();
DROP FUNCTION IF EXISTS archive_audio_asset_trigger();
DROP FUNCTION IF EXISTS archive_novel_chapter_trigger();
DROP FUNCTION IF EXISTS archive_article_trigger();
DROP FUNCTION IF EXISTS archive_comic_script_trigger();
DROP FUNCTION IF EXISTS archive_promo_script_trigger();
DROP FUNCTION IF EXISTS archive_dub_project_trigger();
DROP FUNCTION IF EXISTS archive_agent_workflow_trigger();
DROP FUNCTION IF EXISTS archive_scheduled_report_trigger();
DROP FUNCTION IF EXISTS create_ai_artifacts_kb_for_user_trigger();
DROP FUNCTION IF EXISTS archive_ai_artifact(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMP(3));
DROP FUNCTION IF EXISTS ensure_ai_artifacts_kb(TEXT);
