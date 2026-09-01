-- P5.1：退役 KnowledgeBase.systemKey
--
-- 这一列是 20260717090000_ai_artifact_knowledge_base 给「AI 产物自动归档」加的：
-- 触发器用 `ON CONFLICT ("userId","systemKey") DO UPDATE` 幂等地为每个用户开一个
-- systemKey='AI_ARTIFACTS' 的系统库。`AI_ARTIFACTS` 是这一列**全仓唯一的取值**，
-- 应用代码里从来没有第二个写入者。
--
-- 20260831120000 删了触发器（11 个 trigger + 13 个函数），20260831130000 删了存量
-- （9,661 个产物库），所以这一列现在既没有写入者也没有非空行 —— 留着只会让下一个人
-- 以为「系统知识库」这个概念还在。
--
-- 执行前在本地库（localhost:5433/ai-assistant）核对（2026-09-01）：
--   * KnowledgeBase 共 17 行（16 自建 + 1 官方），systemKey IS NOT NULL **0 行**
--   * 索引 4 个：pkey / userId_idx / ownerType_idx / userId_systemKey_key
--
-- 两点说明：
--   1. Step 1 的守卫不是形式主义。这一列一旦有非空行就说明 20260831130000 在那个库上
--      没清干净，直接 DROP COLUMN 会静默丢掉「哪些库是自动开的」这个唯一判据。
--      宁可让迁移在这里炸掉、先去补跑 P2.1，也不要悄悄删数据。
--   2. Step 2 把 KnowledgeBase_userId_systemKey_key 显式删掉，是为了让意图可读 ——
--      Postgres 在 DROP COLUMN 时本来就会连带删除依赖它的索引。**所以 P5.5 列的两个
--      唯一索引里，KnowledgeBase_userId_systemKey_key 由本条迁移完成**，P5.5 只剩
--      Document_sourceModule_sourceId_key。

-- Step 1：守卫 —— 还有产物库残留就中止，不要静默丢判据。
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM "KnowledgeBase" WHERE "systemKey" IS NOT NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'KnowledgeBase.systemKey 还有 % 行非空，说明 20260831130000（P2.1）在这个库上没清完；先补跑那条迁移再来删列。',
      leftover;
  END IF;
END $$;

-- Step 2：唯一索引（显式删，见上文说明 2）。
DROP INDEX IF EXISTS "KnowledgeBase_userId_systemKey_key";

-- Step 3：删列。
ALTER TABLE "KnowledgeBase" DROP COLUMN "systemKey";
