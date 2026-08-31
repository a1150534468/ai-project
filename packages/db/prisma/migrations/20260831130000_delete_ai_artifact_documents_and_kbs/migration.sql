-- P2.1：清掉历史上被自动归档进知识库的 AI 产物
--
-- 背景：20260831120000 已经删掉了 11 个归档触发器 + 13 个 plpgsql 函数，产物
-- 从此不再写入知识库。这条迁移处理触发器留下的存量残渣，让知识库回到「官方库 +
-- 个人自建库」两类。
--
-- 执行前在本地库（localhost:5433/ai-assistant）实测的范围（2026-08-31）：
--   * Document sourceType='ARTIFACT'                        1,275 行 → 删
--     - 连带 Chunk（Chunk_documentId_fkey ON DELETE CASCADE）  211 行 → 删
--     - 连带 CodexPetRun.knowledgeDocumentId 置空（SET NULL）   43 行
--   * KnowledgeBase systemKey IS NOT NULL                   9,661 行 → 删
--     （其中 8,885 本来就是空库，776 只装产物；删完 776 个也变空）
--   * 删完剩下：Document 8（6 FILE + 2 TEXT，都是用户自己上传的）、
--     KnowledgeBase 17（16 个自建 + 1 个官方）
--
-- 三点安全约束（本地都实测为 0，但生产/别人的库未必，所以写进 SQL 而不是靠数据凑巧）：
--   1. `ownerType = 'USER'` 护栏：唯一的 OFFICIAL 库 systemKey 是 NULL，本来就落不到
--      谓词里；加这条是防止将来有人给官方库塞 systemKey 之后被这条迁移连带删掉。
--   2. 先删文档再删库，且只删空库。Document_kbId_fkey 是 CASCADE，如果反过来先删库，
--      任何被手工上传到产物库里的用户文件会被一起 cascade 掉。
--   3. 万一有库在产物之外还留着用户文件（本地 0 行），不删它，只摘掉 systemKey，让它
--      退化成普通个人库 —— 用户从此能改名、能删（systemKey 的 403 保护见
--      apps/api/src/kb/service.ts，P5.1 才连列一起退役）。

-- Step 1：产物文档。Chunk 走 CASCADE，CodexPetRun.knowledgeDocumentId 走 SET NULL。
DELETE FROM "Document" WHERE "sourceType" = 'ARTIFACT';

-- Step 2：还装着用户文件的产物库 → 降级成普通个人库，不删。
UPDATE "KnowledgeBase"
SET "systemKey" = NULL
WHERE "systemKey" IS NOT NULL
  AND "ownerType" = 'USER'
  AND EXISTS (SELECT 1 FROM "Document" d WHERE d."kbId" = "KnowledgeBase".id);

-- Step 3：已经空掉的产物库 → 删。
DELETE FROM "KnowledgeBase"
WHERE "systemKey" IS NOT NULL
  AND "ownerType" = 'USER'
  AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."kbId" = "KnowledgeBase".id);
