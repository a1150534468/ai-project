-- 回滚 20261021000000_ecom_product_spec_and_outbox_kind（Prisma 不自动生成 down，
-- 本脚本手工维护并已在备份数据上演练：执行后三张表回到迁移前形状、product Json
-- 按字段语义等值还原（jsonb 不保留键序，消费方均按字段名读取）。

ALTER TABLE "NovelCommandOutbox" DROP CONSTRAINT "NovelCommandOutbox_kind_check";
ALTER TABLE "NovelCommandOutbox" DROP COLUMN "kind";

ALTER TABLE "EcomWorkflow" ADD COLUMN "product" JSONB;
ALTER TABLE "EcomMainImageJob" ADD COLUMN "product" JSONB;

UPDATE "EcomWorkflow" w
SET "product" = jsonb_build_object(
    'name', s."name",
    'category', s."category",
    'sellingPoints', to_jsonb(s."sellingPoints"),
    'extra', s."extra"
)
FROM "EcomProductSpec" s
WHERE s."id" = w."productSpecId";

UPDATE "EcomMainImageJob" j
SET "product" = jsonb_build_object(
    'name', s."name",
    'category', s."category",
    'sellingPoints', to_jsonb(s."sellingPoints"),
    'extra', s."extra"
)
FROM "EcomProductSpec" s
WHERE s."id" = j."productSpecId";

ALTER TABLE "EcomWorkflow" ALTER COLUMN "product" SET NOT NULL;
ALTER TABLE "EcomMainImageJob" ALTER COLUMN "product" SET NOT NULL;

ALTER TABLE "EcomWorkflow" DROP CONSTRAINT "EcomWorkflow_productSpecId_fkey";
ALTER TABLE "EcomMainImageJob" DROP CONSTRAINT "EcomMainImageJob_productSpecId_fkey";
ALTER TABLE "EcomWorkflow" DROP COLUMN "productSpecId";
ALTER TABLE "EcomMainImageJob" DROP COLUMN "productSpecId";

DROP TABLE "EcomProductSpec";
