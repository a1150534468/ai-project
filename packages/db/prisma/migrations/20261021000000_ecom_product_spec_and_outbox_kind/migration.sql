-- 提示词 12：电商 product Json 提成 EcomProductSpec 真表 + outbox 加 kind 判别列。
-- 数据回填与约束都在本文件内完成；回滚脚本见同目录 rollback.sql（已在备份数据上演练）。

-- 1) 商品规格表（列与 CHECK 对齐 api 侧 productSchema：name/category ≤200 字、
--    extra ≤2000 字、sellingPoints ≤12 条；name 允许空串——adopt-master 流程的
--    既有合法状态就是空名，min(1) 由主创建路径的 zod 继续把守）
CREATE TABLE "EcomProductSpec" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "sellingPoints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extra" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomProductSpec_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EcomProductSpec_name_len" CHECK (char_length("name") <= 200),
    CONSTRAINT "EcomProductSpec_category_len" CHECK (char_length("category") <= 200),
    CONSTRAINT "EcomProductSpec_extra_len" CHECK (char_length("extra") <= 2000),
    CONSTRAINT "EcomProductSpec_selling_points_max" CHECK (cardinality("sellingPoints") <= 12)
);

-- 2) 两张电商表加外键列（先可空，回填后收紧）
ALTER TABLE "EcomWorkflow" ADD COLUMN "productSpecId" TEXT;
ALTER TABLE "EcomMainImageJob" ADD COLUMN "productSpecId" TEXT;

-- 3) 回填：一条 job 行一条 spec（product 是 job 私有快照，不跨行共享）；
--    id 用表前缀 + job id，确定性且全局唯一，失败重跑不产生重复行
INSERT INTO "EcomProductSpec" ("id", "name", "category", "sellingPoints", "extra", "createdAt", "updatedAt")
SELECT
    'ews_' || w."id",
    COALESCE(w."product" ->> 'name', ''),
    COALESCE(w."product" ->> 'category', ''),
    CASE
        WHEN jsonb_typeof(w."product" -> 'sellingPoints') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(w."product" -> 'sellingPoints'))
        ELSE ARRAY[]::TEXT[]
    END,
    COALESCE(w."product" ->> 'extra', ''),
    w."createdAt",
    w."updatedAt"
FROM "EcomWorkflow" w;

INSERT INTO "EcomProductSpec" ("id", "name", "category", "sellingPoints", "extra", "createdAt", "updatedAt")
SELECT
    'emi_' || j."id",
    COALESCE(j."product" ->> 'name', ''),
    COALESCE(j."product" ->> 'category', ''),
    CASE
        WHEN jsonb_typeof(j."product" -> 'sellingPoints') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(j."product" -> 'sellingPoints'))
        ELSE ARRAY[]::TEXT[]
    END,
    COALESCE(j."product" ->> 'extra', ''),
    j."createdAt",
    j."updatedAt"
FROM "EcomMainImageJob" j;

UPDATE "EcomWorkflow" SET "productSpecId" = 'ews_' || "id";
UPDATE "EcomMainImageJob" SET "productSpecId" = 'emi_' || "id";

-- 4) 收紧为 NOT NULL 并加外键，随后删 Json 列
ALTER TABLE "EcomWorkflow" ALTER COLUMN "productSpecId" SET NOT NULL;
ALTER TABLE "EcomMainImageJob" ALTER COLUMN "productSpecId" SET NOT NULL;
ALTER TABLE "EcomWorkflow" ADD CONSTRAINT "EcomWorkflow_productSpecId_fkey" FOREIGN KEY ("productSpecId") REFERENCES "EcomProductSpec"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EcomMainImageJob" ADD CONSTRAINT "EcomMainImageJob_productSpecId_fkey" FOREIGN KEY ("productSpecId") REFERENCES "EcomProductSpec"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EcomWorkflow" DROP COLUMN "product";
ALTER TABLE "EcomMainImageJob" DROP COLUMN "product";

-- 5) outbox kind 判别列：先按 payload.type 回填，缺失/脏值按 stepId/taskId 归位，再加 CHECK
ALTER TABLE "NovelCommandOutbox" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'engine-step';
UPDATE "NovelCommandOutbox"
SET "kind" = COALESCE(
    NULLIF("payload" ->> 'type', ''),
    CASE WHEN "stepId" IS NOT NULL THEN 'engine-step' ELSE 'generation-task' END
);
UPDATE "NovelCommandOutbox"
SET "kind" = CASE WHEN "stepId" IS NOT NULL THEN 'engine-step' ELSE 'generation-task' END
WHERE "kind" NOT IN ('engine-step', 'generation-task');
ALTER TABLE "NovelCommandOutbox" ADD CONSTRAINT "NovelCommandOutbox_kind_check" CHECK ("kind" IN ('engine-step', 'generation-task'));
