import type { Redis } from "ioredis";

export const AVATAR_QUOTA_PER_HOUR = 20;
const WINDOW_SEC = 3600;

/** 环境:业务:模块:功能:标识 */
export function avatarQuotaKey(env: string, userId: string): string {
  return `${env}:agent:avatar:ratelimit:${userId}`;
}

/**
 * 固定窗口计数。INCR 返回 1 说明是本窗口第一次，此时才设 TTL——
 * 每次都 EXPIRE 会让活跃用户的窗口被无限续期，等于没有限流。
 * 返回 true = 放行。
 */
export async function consumeAvatarQuota(redis: Redis, userId: string): Promise<boolean> {
  const key = avatarQuotaKey(process.env.NODE_ENV ?? "dev", userId);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, WINDOW_SEC);
  return n <= AVATAR_QUOTA_PER_HOUR;
}
