-- P5.2：退役 Document 上四列产物专用字段（sourceModule / sourceId / metadata / content）
--
-- 四列都是 20260717090000_ai_artifact_knowledge_base 给「AI 产物自动归档」加的，
-- 分工是：sourceModule + sourceId 记「这份文档是哪个模块的哪条业务记录变来的」并靠
-- Document_sourceModule_sourceId_key 做触发器的幂等键；metadata 存产物快照；content
-- 存内联正文（产物不落 S3，正文直接写在行里，配 sourceType='ARTIFACT' 用）。
--
-- 触发器在 20260831120000 删净，存量在 20260831130000 删净（1,265 个产物文档），
-- 20260901120000（P5.1）退了 KnowledgeBase.systemKey。到这一步四列既没有写入者也
-- 没有非空行。
--
-- 「content 除 ARTIFACT 外还有没有写入者」是本项开工前必须核实的一条（计划开放问题 4），
-- 已在改代码前重新核过当前工作树，不是照抄 P2 的旧结论：
--   * 全仓唯一的生产 `document.create` 是 kb/ingest.ts:238，它只写
--     kbId/name/sourceType/sourceUri/mime/sizeBytes，四列一个都不写；那里的
--     sourceType 变量类型就是 "TEXT" | "URL" | "FILE"，写不出 ARTIFACT。
--   * 手工 TEXT 上传**不用 content**：ingest.ts:231-234 把正文 putObject 进 S3，
--     sourceUri 记的是 S3 key；kb/deps.ts:37-42 读回来时 TEXT 和 FILE 走同一条
--     getObject 分支。这正是计划要问的那一句，答案是「不用」。
--   * 两处生产 `document.update`（indexer.ts:335 / :364）只碰
--     status/chunkCount/tokensUsed/lockedBy/lockedAt/error。
--   * content 的读点只有 3 个：indexer.ts:108（loadObject 签名字段）、
--     indexer.ts:250（原样透传）、deps.ts:30-36（ARTIFACT 分支，P1.2 后不可达）。
--     retrieve.ts 里的 content 是 Chunk.content，另一张表。
--
-- 执行前在本地库（localhost:5433/ai-assistant）核对（2026-09-01）：
--   * Document 共 8 行（FILE 6 + TEXT 2，ARTIFACT 0），21 列
--   * content / metadata / sourceModule / sourceId 四列**非空行各为 0**
--   * 索引 4 个：pkey / kbId_idx / status_idx / sourceModule_sourceId_key
--
-- 两点说明：
--   1. Step 1 的守卫同 P5.1：四列任一还有非空行，就说明 20260831130000（P2.1）在那个
--      库上没清完，直接 DROP COLUMN 会把「这份文档原本对应哪条业务记录」这唯一判据
--      静默烧掉。宁可炸在这里、先补跑 P2.1。
--   2. Step 2 显式删 Document_sourceModule_sourceId_key（Postgres 本来会随 DROP COLUMN
--      连带删掉，写出来只为可读）。**P5.5 的两个唯一索引到此全部结清**：
--      KnowledgeBase_userId_systemKey_key 由 P5.1 完成，这一个由本条完成，P5.5 自身
--      没有剩余工作。

-- Step 1：守卫 —— 四列任一还有产物残留就中止，不要静默丢判据。
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover
    FROM "Document"
    WHERE "sourceModule" IS NOT NULL
       OR "sourceId" IS NOT NULL
       OR "metadata" IS NOT NULL
       OR "content" IS NOT NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'Document 的产物四列还有 % 行非空，说明 20260831130000（P2.1）在这个库上没清完；先补跑那条迁移再来删列。',
      leftover;
  END IF;
END $$;

-- Step 2：唯一索引（显式删，见上文说明 2）。
DROP INDEX IF EXISTS "Document_sourceModule_sourceId_key";

-- Step 3：删列。
ALTER TABLE "Document"
  DROP COLUMN "sourceModule",
  DROP COLUMN "sourceId",
  DROP COLUMN "metadata",
  DROP COLUMN "content";
