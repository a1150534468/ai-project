import type { Redis } from "ioredis";
import { consumeQuota, QUOTA_PRESETS, QUOTA_SCOPE } from "../shared/quota.js";

/**
 * 头像额度。实现已经搬到 `shared/quota.ts` 的通用额度闸，这里只留头像自己的口径：
 * 一个老格式的 key 和一份「每条路由各多少次」的常量。
 */
export const AVATAR_QUOTA_PER_HOUR = QUOTA_PRESETS.agentAvatar.limit;

/** 窗口长度。固定窗口，不滑动 —— 到点整批清零。 */
const WINDOW_SECONDS = QUOTA_PRESETS.agentAvatar.windowSeconds;

/** key 的分段是全仓约定：`环境:业务:模块:功能:标识`。 */
export function avatarQuotaKey(env: string, userId: string): string {
  return `${env}:agent:avatar:ratelimit:${userId}`;
}

/**
 * 记一次头像操作，返回是否放行（`true` = 还在额度内）。
 *
 * 计数与 TTL 自愈的完整说明见 `shared/quota.ts` 的 `consumeQuota`——本函数只是它的一层
 * 薄 wrapper，唯一多做的事是**把 key 钉死在老格式上**：这个计数器线上正在用，
 * 换成通用的 `${env}:quota:agent:avatar:${userId}` 等于给所有用户重置额度。
 */
export async function consumeAvatarQuota(redis: Redis, userId: string): Promise<boolean> {
  return consumeQuota(redis, {
    scope: QUOTA_SCOPE.agentAvatar,
    userId,
    limit: AVATAR_QUOTA_PER_HOUR,
    windowSeconds: WINDOW_SECONDS,
    key: avatarQuotaKey(process.env.NODE_ENV ?? "dev", userId),
  });
}
