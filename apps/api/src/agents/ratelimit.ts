import type { Redis } from "ioredis";

/** 每个用户每小时能重画/上传多少次头像。两条路由（regenerate / upload）共用这一份额度。 */
export const AVATAR_QUOTA_PER_HOUR = 20;

/** 窗口长度。固定窗口，不滑动 —— 到点整批清零。 */
const WINDOW_SECONDS = 3600;

/** key 的分段是全仓约定：`环境:业务:模块:功能:标识`。 */
export function avatarQuotaKey(env: string, userId: string): string {
  return `${env}:agent:avatar:ratelimit:${userId}`;
}

/**
 * 记一次头像操作，返回是否放行（`true` = 还在额度内）。
 *
 * 固定窗口计数：计数器自增到超过 {@link AVATAR_QUOTA_PER_HOUR} 就开始拒，等 TTL 到点自然清零。
 * **绝不能每次都续 TTL** —— 那样活跃用户的窗口永远不结束，等于没有限流。
 *
 * INCR 和 TTL 放在同一个 MULTI 里，是为了一次往返同时拿到「这是第几次」和「窗口还剩多久」。
 * 只在 `ttl < 0` 时才补 EXPIRE，覆盖两种情况：
 *
 * - 窗口第一次（INCR 刚把 key 建出来，还没有 TTL）；
 * - **key 把 TTL 丢了**。旧实现只在计数为 1 的那一次设 TTL，所以进程在 INCR 与 EXPIRE
 *   之间挂掉、或者那一条 EXPIRE 自己失败，这个 key 就永久没有过期时间 ——
 *   用户从此再也画不了头像，而且没有任何日志会提到这件事。现在每次都顺手体检一遍，
 *   发现没 TTL 就重新钉上，成本是零（TTL 和 INCR 同一次往返）。
 */
export async function consumeAvatarQuota(redis: Redis, userId: string): Promise<boolean> {
  const key = avatarQuotaKey(process.env.NODE_ENV ?? "dev", userId);

  const replies = await redis.multi().incr(key).ttl(key).exec();
  // exec() 只有在 WATCH 冲突时才回 null，这里没有 WATCH；真回 null 也当「放行」处理，
  // 限流器自己出故障不该把用户的正常操作打死。
  if (!replies) return true;
  const used = Number(replies[0]?.[1] ?? 0);
  const ttl = Number(replies[1]?.[1] ?? -1);

  if (ttl < 0) await redis.expire(key, WINDOW_SECONDS);

  return used <= AVATAR_QUOTA_PER_HOUR;
}
