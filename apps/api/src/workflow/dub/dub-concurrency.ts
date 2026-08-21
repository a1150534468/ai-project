import type { Redis } from "ioredis";
import { DUB_SKY_INFLIGHT_KEY, DUB_SKY_SLOT_TTL_SEC } from "./dub-constants.js";

// INCR 抢位，超限则 DECR 回退。TTL 兜底进程崩溃不泄漏（每次抢位刷新过期）。
export async function acquireSkySlot(redis: Pick<Redis, "incr" | "decr" | "expire">, max: number): Promise<boolean> {
  const n = await redis.incr(DUB_SKY_INFLIGHT_KEY);
  await redis.expire(DUB_SKY_INFLIGHT_KEY, DUB_SKY_SLOT_TTL_SEC);
  if (n > max) { await redis.decr(DUB_SKY_INFLIGHT_KEY); return false; }
  return true;
}

export async function releaseSkySlot(redis: Pick<Redis, "decr">): Promise<void> {
  await redis.decr(DUB_SKY_INFLIGHT_KEY);
}
