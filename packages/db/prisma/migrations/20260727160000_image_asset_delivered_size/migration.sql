-- ImageAsset.size 记的是请求尺寸；中转上游常只认宽高比、忽略绝对像素，
-- 导致请求 2K 实际只交付 1K 像素时按请求档多收一倍点数。
-- 这两列记录实际交付像素，供结算时按真实档位定价。历史数据留 NULL，结算回落请求档。
ALTER TABLE "ImageAsset" ADD COLUMN "width" INTEGER;
ALTER TABLE "ImageAsset" ADD COLUMN "height" INTEGER;
