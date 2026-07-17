-- AI 产物统一归档：系统知识库、产物来源信息与内联可索引文本。
ALTER TABLE "KnowledgeBase" ADD COLUMN "systemKey" TEXT;
ALTER TABLE "Document"
  ADD COLUMN "content" TEXT,
  ADD COLUMN "sourceModule" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "metadata" JSONB;

CREATE UNIQUE INDEX "KnowledgeBase_userId_systemKey_key"
  ON "KnowledgeBase"("userId", "systemKey");
CREATE UNIQUE INDEX "Document_sourceModule_sourceId_key"
  ON "Document"("sourceModule", "sourceId");

-- 配额包购买已下线；保留 KbQuotaGrant 以兼容已有购买授予和管理员扩容。
DROP TABLE IF EXISTS "KbQuotaPackage";

CREATE OR REPLACE FUNCTION ensure_ai_artifacts_kb(p_user_id TEXT)
RETURNS TEXT AS $$
DECLARE
  v_kb_id TEXT := 'ai_artifacts_' || md5(p_user_id);
BEGIN
  INSERT INTO "KnowledgeBase" (
    "id", "ownerType", "userId", "systemKey", "name", "description", "createdAt", "updatedAt"
  ) VALUES (
    v_kb_id,
    'USER',
    p_user_id,
    'AI_ARTIFACTS',
    'AI 产物',
    '生图、视频、音频、小说、文章等 AI 生成结果会自动归档到这里。',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("userId", "systemKey") DO UPDATE
    SET "updatedAt" = "KnowledgeBase"."updatedAt"
  RETURNING "id" INTO v_kb_id;
  RETURN v_kb_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_ai_artifact(
  p_user_id TEXT,
  p_source_module TEXT,
  p_source_id TEXT,
  p_name TEXT,
  p_uri TEXT,
  p_mime TEXT,
  p_content TEXT,
  p_metadata JSONB,
  p_created_at TIMESTAMP(3)
) RETURNS VOID AS $$
DECLARE
  v_kb_id TEXT;
  v_content TEXT := NULLIF(BTRIM(COALESCE(p_content, '')), '');
BEGIN
  v_kb_id := ensure_ai_artifacts_kb(p_user_id);

  INSERT INTO "Document" (
    "id", "kbId", "name", "sourceType", "sourceUri", "content", "mime", "sizeBytes",
    "status", "sourceModule", "sourceId", "metadata", "attempts", "createdAt", "updatedAt"
  ) VALUES (
    'ai_artifact_' || md5(p_source_module || ':' || p_source_id),
    v_kb_id,
    p_name,
    'ARTIFACT',
    p_uri,
    v_content,
    p_mime,
    0,
    CASE WHEN v_content IS NULL THEN 'indexed' ELSE 'pending' END,
    p_source_module,
    p_source_id,
    COALESCE(p_metadata, '{}'::jsonb),
    0,
    COALESCE(p_created_at, CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("sourceModule", "sourceId") DO UPDATE SET
    "kbId" = EXCLUDED."kbId",
    "name" = EXCLUDED."name",
    "sourceUri" = EXCLUDED."sourceUri",
    "content" = EXCLUDED."content",
    "mime" = EXCLUDED."mime",
    "metadata" = EXCLUDED."metadata",
    "status" = CASE WHEN EXCLUDED."content" IS NULL THEN 'indexed' ELSE 'pending' END,
    "error" = NULL,
    "lockedBy" = NULL,
    "lockedAt" = NULL,
    "attempts" = 0,
    "updatedAt" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_image_asset_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM archive_ai_artifact(
    NEW."userId", 'image', NEW."id",
    'AI 图片 · ' || to_char(NEW."createdAt", 'YYYY-MM-DD HH24:MI'),
    NEW."originalUrl", NEW."mime",
    '图片提示词：' || COALESCE(NEW."prompt", ''),
    jsonb_build_object('model', NEW."model", 'size', NEW."size", 'thumbnailUrl', NEW."thumbnailUrl"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_video_asset_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM archive_ai_artifact(
    NEW."userId", 'video', NEW."id",
    'AI 视频 · ' || to_char(NEW."createdAt", 'YYYY-MM-DD HH24:MI'),
    NEW."originalUrl", NEW."mime",
    '视频提示词：' || COALESCE(NEW."prompt", ''),
    jsonb_build_object('model', NEW."model", 'resolution', NEW."resolution", 'durationSec', NEW."durationSec"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_audio_asset_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM archive_ai_artifact(
    NEW."userId", 'audio', NEW."id",
    'AI 音频 · ' || to_char(NEW."createdAt", 'YYYY-MM-DD HH24:MI'),
    NEW."originalUrl", NEW."mime",
    COALESCE(NULLIF(NEW."textContent", ''), '音频类型：' || COALESCE(NEW."kind", '音频')),
    jsonb_build_object('kind', NEW."kind", 'source', NEW."source", 'durationSec', NEW."durationSec"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_novel_chapter_trigger() RETURNS TRIGGER AS $$
DECLARE
  v_project "NovelProject"%ROWTYPE;
BEGIN
  IF BTRIM(COALESCE(NEW."content", '')) = '' THEN RETURN NEW; END IF;
  SELECT * INTO v_project FROM "NovelProject" WHERE "id" = NEW."projectId";
  PERFORM archive_ai_artifact(
    v_project."userId", 'novel', NEW."id",
    v_project."title" || ' · 第' || NEW."chapterIndex" || '章 ' || COALESCE(NEW."title", ''),
    NULL, 'text/plain',
    COALESCE(NEW."title", '') || E'\n\n' || NEW."content",
    jsonb_build_object('projectId', NEW."projectId", 'chapterIndex', NEW."chapterIndex", 'genre', v_project."genre"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_article_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF BTRIM(COALESCE(NEW."bodyHtml", '')) = '' THEN RETURN NEW; END IF;
  PERFORM archive_ai_artifact(
    NEW."userId", 'article', NEW."id",
    'AI 文章 · ' || COALESCE(NULLIF(NEW."title", ''), to_char(NEW."createdAt", 'YYYY-MM-DD HH24:MI')),
    NULL, 'text/plain',
    COALESCE(NEW."title", '') || E'\n' || COALESCE(NEW."summary", '') || E'\n\n' || NEW."bodyHtml",
    jsonb_build_object('status', NEW."status", 'sourceFormat', NEW."sourceFormat"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_comic_script_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF BTRIM(COALESCE(NEW."scriptText", '')) = '' THEN RETURN NEW; END IF;
  PERFORM archive_ai_artifact(
    NEW."userId", 'comic_script', NEW."id",
    '漫画剧本 · 第 ' || NEW."versionNo" || ' 版',
    NULL, 'text/plain',
    COALESCE(NEW."outline", '') || E'\n\n' || NEW."scriptText",
    jsonb_build_object('projectId', NEW."projectId", 'episodeId', NEW."episodeId", 'versionNo', NEW."versionNo"),
    NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_promo_script_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF BTRIM(COALESCE(NEW."scriptDraft", '')) = '' THEN RETURN NEW; END IF;
  PERFORM archive_ai_artifact(
    NEW."userId", 'promo_script', NEW."id",
    '宣传片脚本 · ' || NEW."title", NULL, 'text/plain', NEW."scriptDraft",
    jsonb_build_object('projectId', NEW."id", 'status', NEW."status"), NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_dub_project_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF BTRIM(COALESCE(NEW."script", '')) = ''
     AND COALESCE(NEW."finalVideoUrl", NEW."resultVideoUrl", NEW."audioUrl") IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM archive_ai_artifact(
    NEW."userId", 'dub', NEW."id",
    'AI 口播 · ' || NEW."title",
    COALESCE(NEW."finalVideoUrl", NEW."resultVideoUrl", NEW."audioUrl"),
    CASE WHEN COALESCE(NEW."finalVideoUrl", NEW."resultVideoUrl") IS NOT NULL THEN 'video/mp4' ELSE 'text/plain' END,
    COALESCE(NULLIF(NEW."script", ''), 'AI 口播产物'),
    jsonb_build_object('projectId', NEW."id", 'stage', NEW."stage"), NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_agent_workflow_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF BTRIM(COALESCE(NEW."finalReport", '')) = '' THEN RETURN NEW; END IF;
  PERFORM archive_ai_artifact(
    NEW."userId", 'agent_workflow', NEW."id",
    '智能体任务 · ' || LEFT(NEW."taskGoal", 80), NULL, 'text/plain', NEW."finalReport",
    jsonb_build_object('runId', NEW."id", 'status', NEW."status", 'taskGoal', NEW."taskGoal"), NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION archive_scheduled_report_trigger() RETURNS TRIGGER AS $$
DECLARE
  v_title TEXT;
BEGIN
  IF BTRIM(COALESCE(NEW."reportText", '')) = '' THEN RETURN NEW; END IF;
  SELECT "title" INTO v_title FROM "ScheduledTask" WHERE "id" = NEW."taskId";
  PERFORM archive_ai_artifact(
    NEW."userId", 'scheduled_report', NEW."id",
    '定时任务报告 · ' || COALESCE(v_title, NEW."taskId"), NULL, 'text/plain', NEW."reportText",
    jsonb_build_object('taskId', NEW."taskId", 'status', NEW."status", 'triggeredAt', NEW."triggeredAt"), NEW."createdAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_ai_artifacts_kb_for_user_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM ensure_ai_artifacts_kb(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_ai_artifacts_kb" AFTER INSERT ON "User"
  FOR EACH ROW EXECUTE FUNCTION create_ai_artifacts_kb_for_user_trigger();
CREATE TRIGGER "ImageAsset_archive" AFTER INSERT ON "ImageAsset"
  FOR EACH ROW EXECUTE FUNCTION archive_image_asset_trigger();
CREATE TRIGGER "VideoAsset_archive" AFTER INSERT ON "VideoAsset"
  FOR EACH ROW EXECUTE FUNCTION archive_video_asset_trigger();
CREATE TRIGGER "AudioAsset_archive" AFTER INSERT ON "AudioAsset"
  FOR EACH ROW EXECUTE FUNCTION archive_audio_asset_trigger();
CREATE TRIGGER "NovelChapter_archive" AFTER INSERT OR UPDATE OF "content", "title" ON "NovelChapter"
  FOR EACH ROW EXECUTE FUNCTION archive_novel_chapter_trigger();
CREATE TRIGGER "ArticleWorkflowProject_archive" AFTER INSERT OR UPDATE OF "bodyHtml", "title", "summary" ON "ArticleWorkflowProject"
  FOR EACH ROW EXECUTE FUNCTION archive_article_trigger();
CREATE TRIGGER "ComicWorkflowScriptVersion_archive" AFTER INSERT OR UPDATE OF "scriptText", "outline" ON "ComicWorkflowScriptVersion"
  FOR EACH ROW EXECUTE FUNCTION archive_comic_script_trigger();
CREATE TRIGGER "LocalBusinessPromoProject_archive" AFTER INSERT OR UPDATE OF "scriptDraft", "title" ON "LocalBusinessPromoProject"
  FOR EACH ROW EXECUTE FUNCTION archive_promo_script_trigger();
CREATE TRIGGER "DubProject_archive" AFTER INSERT OR UPDATE OF "script", "finalVideoUrl", "resultVideoUrl", "audioUrl", "title" ON "DubProject"
  FOR EACH ROW EXECUTE FUNCTION archive_dub_project_trigger();
CREATE TRIGGER "AgentWorkflowRun_archive" AFTER INSERT OR UPDATE OF "finalReport" ON "AgentWorkflowRun"
  FOR EACH ROW EXECUTE FUNCTION archive_agent_workflow_trigger();
CREATE TRIGGER "ScheduledTaskRun_archive" AFTER INSERT OR UPDATE OF "reportText" ON "ScheduledTaskRun"
  FOR EACH ROW EXECUTE FUNCTION archive_scheduled_report_trigger();

-- Every account gets the system library, including existing users.
SELECT ensure_ai_artifacts_kb("id") FROM "User";

-- Backfill existing products. Triggers will keep subsequent inserts/updates in sync.
SELECT archive_ai_artifact(
  "userId", 'image', "id", 'AI 图片 · ' || to_char("createdAt", 'YYYY-MM-DD HH24:MI'),
  "originalUrl", "mime", '图片提示词：' || COALESCE("prompt", ''),
  jsonb_build_object('model', "model", 'size', "size", 'thumbnailUrl', "thumbnailUrl"), "createdAt"
) FROM "ImageAsset";

SELECT archive_ai_artifact(
  "userId", 'video', "id", 'AI 视频 · ' || to_char("createdAt", 'YYYY-MM-DD HH24:MI'),
  "originalUrl", "mime", '视频提示词：' || COALESCE("prompt", ''),
  jsonb_build_object('model', "model", 'resolution', "resolution", 'durationSec', "durationSec"), "createdAt"
) FROM "VideoAsset";

SELECT archive_ai_artifact(
  "userId", 'audio', "id", 'AI 音频 · ' || to_char("createdAt", 'YYYY-MM-DD HH24:MI'),
  "originalUrl", "mime", COALESCE(NULLIF("textContent", ''), '音频类型：' || COALESCE("kind", '音频')),
  jsonb_build_object('kind', "kind", 'source', "source", 'durationSec', "durationSec"), "createdAt"
) FROM "AudioAsset";

SELECT archive_ai_artifact(
  p."userId", 'novel', c."id", p."title" || ' · 第' || c."chapterIndex" || '章 ' || COALESCE(c."title", ''),
  NULL, 'text/plain', COALESCE(c."title", '') || E'\n\n' || c."content",
  jsonb_build_object('projectId', p."id", 'chapterIndex', c."chapterIndex", 'genre', p."genre"), c."createdAt"
) FROM "NovelChapter" c JOIN "NovelProject" p ON p."id" = c."projectId"
WHERE BTRIM(COALESCE(c."content", '')) <> '';

SELECT archive_ai_artifact(
  "userId", 'article', "id", 'AI 文章 · ' || COALESCE(NULLIF("title", ''), to_char("createdAt", 'YYYY-MM-DD HH24:MI')),
  NULL, 'text/plain', COALESCE("title", '') || E'\n' || COALESCE("summary", '') || E'\n\n' || "bodyHtml",
  jsonb_build_object('status', "status", 'sourceFormat', "sourceFormat"), "createdAt"
) FROM "ArticleWorkflowProject" WHERE BTRIM(COALESCE("bodyHtml", '')) <> '';

SELECT archive_ai_artifact(
  "userId", 'comic_script', "id", '漫画剧本 · 第 ' || "versionNo" || ' 版',
  NULL, 'text/plain', COALESCE("outline", '') || E'\n\n' || "scriptText",
  jsonb_build_object('projectId', "projectId", 'episodeId', "episodeId", 'versionNo', "versionNo"), "createdAt"
) FROM "ComicWorkflowScriptVersion" WHERE BTRIM(COALESCE("scriptText", '')) <> '';

SELECT archive_ai_artifact(
  "userId", 'promo_script', "id", '宣传片脚本 · ' || "title", NULL, 'text/plain', "scriptDraft",
  jsonb_build_object('projectId', "id", 'status', "status"), "createdAt"
) FROM "LocalBusinessPromoProject" WHERE BTRIM(COALESCE("scriptDraft", '')) <> '';

SELECT archive_ai_artifact(
  "userId", 'dub', "id", 'AI 口播 · ' || "title",
  COALESCE("finalVideoUrl", "resultVideoUrl", "audioUrl"),
  CASE WHEN COALESCE("finalVideoUrl", "resultVideoUrl") IS NOT NULL THEN 'video/mp4' ELSE 'text/plain' END,
  COALESCE(NULLIF("script", ''), 'AI 口播产物'),
  jsonb_build_object('projectId', "id", 'stage', "stage"), "createdAt"
) FROM "DubProject"
WHERE BTRIM(COALESCE("script", '')) <> '' OR COALESCE("finalVideoUrl", "resultVideoUrl", "audioUrl") IS NOT NULL;

SELECT archive_ai_artifact(
  "userId", 'agent_workflow', "id", '智能体任务 · ' || LEFT("taskGoal", 80), NULL, 'text/plain', "finalReport",
  jsonb_build_object('runId', "id", 'status', "status", 'taskGoal', "taskGoal"), "createdAt"
) FROM "AgentWorkflowRun" WHERE BTRIM(COALESCE("finalReport", '')) <> '';

SELECT archive_ai_artifact(
  r."userId", 'scheduled_report', r."id", '定时任务报告 · ' || t."title", NULL, 'text/plain', r."reportText",
  jsonb_build_object('taskId', r."taskId", 'status', r."status", 'triggeredAt', r."triggeredAt"), r."createdAt"
) FROM "ScheduledTaskRun" r JOIN "ScheduledTask" t ON t."id" = r."taskId"
WHERE BTRIM(COALESCE(r."reportText", '')) <> '';
