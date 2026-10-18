-- 贴纸工坊：StickerPack.executionToken（可空）
--
-- 同一 pack 重试会启动新一轮 runner（/retry 或 reaper 之后）。旧 runner 可能
-- 还活着并继续推进；每轮执行分配唯一 token，runner 在每次落盘/状态更新时用
-- updateMany(where: { id, executionToken }) 校验归属，抢不到就停，避免两轮
-- 同时生成造成重复付费。
ALTER TABLE "StickerPack" ADD COLUMN "executionToken" TEXT;
