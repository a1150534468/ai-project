import type { Redis } from "ioredis";

const WINDOW_SEC = 3600;

/** 环境:业务:模块:功能:标识 */
export function dubParseRateKey(env: string, userId: string): string {
  return `${env}:dub:parse:ratelimit:${userId}`;
}

/** 固定窗口；INCR==1 才设 TTL。返回 true=放行。 */
export async function consumeDubParseQuota(redis: Redis, userId: string, quotaPerHour: number): Promise<boolean> {
  const key = dubParseRateKey(process.env.NODE_ENV ?? "dev", userId);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, WINDOW_SEC);
  return n <= quotaPerHour;
}
