-- P5.4：退役 CodexPetRun.knowledgeDocumentId 与它的外键
--
-- 这一列是 20260717180000_codex_pet_workflow 给「桌宠交付完自动归档进知识库」加的：
-- archiving 阶段建出一份 sourceType='ARTIFACT' 的 Document，把它的 id 记在这里，面板
-- 据此给出「在 AI 产物中查看」的入口。CodexPetRun_knowledgeDocumentId_key 保证一份产物
-- 文档只归一次运行；外键 ON DELETE SET NULL 保证文档被删时这里自动置空。
--
-- 那条链已经整条拆掉，这一列到这一步既没有写入者也没有非空行：
--   * 20260831120000（P0.4/P1）删净归档触发器；
--   * 20260831130000（P2.1）删掉产物文档，**本列的 43 个非空值就是那时被这条外键
--     SET NULL 冲掉的**（那条迁移的头注释把这 43 行写在了预期影响里）；
--   * P1.2 把 archiving 改成直通阶段（见 runner-archive.ts 头注释：只结清按张计费、
--     置 ready、发事件），登记动作没了，此后不再有任何写入者；
--   * P0.3 已让「ready + knowledgeDocumentId = null」成为合法终态，所以删列不会撞上
--     某个还在等归档的中间态；
--   * 20260901130000（P5.2）退掉 Document 的产物四列，被这一列指向的那种文档从此
--     根本不存在。
--
-- 执行前在本地库（localhost:5433/ai-assistant）核对（2026-09-01）：
--   * CodexPetRun 共 127 行、60 列，knowledgeDocumentId **非空行 0**
--   * 约束 4 条：pkey / projectId_fkey / userId_fkey / knowledgeDocumentId_fkey
--   * 索引 10 个，其中 CodexPetRun_knowledgeDocumentId_key 是本列的唯一索引
--   * 应用侧已无写入者（grep 全仓：生产代码只剩 serializeRun 往响应里透传一个恒为
--     null 的字段，本项一并摘掉），codex-pet 路径下也没有任何 prisma.document.* 调用
--
-- 两点说明：
--   1. Step 1 的守卫同 P5.1/P5.2：还有非空行就说明 20260831130000（P2.1）在那个库上
--      没清完，此时删列会静默烧掉「这次运行当年归档成了哪份文档」这唯一线索。宁可炸
--      在这里，先补跑 P2.1。
--   2. Step 2/3 显式删外键与唯一索引。Postgres 本来会随 DROP COLUMN 连带删掉两者，
--      写出来只为可读——这也是 P5.5 只剩注释、没有剩余工作的同一个机制。

-- Step 1：守卫 —— 还有归档指针就中止，不要静默丢线索。
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover
    FROM "CodexPetRun"
    WHERE "knowledgeDocumentId" IS NOT NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'CodexPetRun.knowledgeDocumentId 还有 % 行非空，说明 20260831130000（P2.1）在这个库上没清完；先补跑那条迁移再来删列。',
      leftover;
  END IF;
END $$;

-- Step 2：外键（显式删，见上文说明 2）。
ALTER TABLE "CodexPetRun"
  DROP CONSTRAINT IF EXISTS "CodexPetRun_knowledgeDocumentId_fkey";

-- Step 3：唯一索引（显式删，同上）。
DROP INDEX IF EXISTS "CodexPetRun_knowledgeDocumentId_key";

-- Step 4：删列。
ALTER TABLE "CodexPetRun"
  DROP COLUMN "knowledgeDocumentId";
