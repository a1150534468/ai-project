import type { Redis } from "ioredis";

export const SCHED_AI_QUOTA_PER_HOUR = 30;
const WINDOW_SEC = 3600;

/** 环境:业务:模块:功能:标识 */
export function schedAiQuotaKey(env: string, userId: string): string {
  return `${env}:sched:ai-draft:ratelimit:${userId}`;
}

/** 固定窗口计数；INCR 返回 1 才设 TTL。返回 true = 放行。 */
export async function consumeSchedAiQuota(redis: Redis, userId: string): Promise<boolean> {
  const key = schedAiQuotaKey(process.env.NODE_ENV ?? "dev", userId);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, WINDOW_SEC);
  return n <= SCHED_AI_QUOTA_PER_HOUR;
}
