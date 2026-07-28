-- 通用生图任务:预扣/结算计费状态
ALTER TABLE "ImageGenerationTask" ADD COLUMN "billingMode" TEXT NOT NULL DEFAULT 'charge';
ALTER TABLE "ImageGenerationTask" ADD COLUMN "billingResourceKey" TEXT;
ALTER TABLE "ImageGenerationTask" ADD COLUMN "billingReservedUnits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImageGenerationTask" ADD COLUMN "billingSettledUnits" INTEGER;
ALTER TABLE "ImageGenerationTask" ADD COLUMN "billingStatus" TEXT;

-- 电商主图/详情长图:生成模型选择
ALTER TABLE "EcomMainImageJob" ADD COLUMN "model" TEXT;
ALTER TABLE "EcomWorkflow" ADD COLUMN "model" TEXT;
