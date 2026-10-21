import { getRedis } from "@ai-assistant/db";
import type { Redis } from "ioredis";

/**
 * 成本型端点的额度闸。
 *
 * 为什么需要它：计费退役后（见 `workflow/_shared/unmetered-image-usage.ts`，所有价格
 * 都是 0），调用模型不再有任何一道闸——注册无门槛、全站也没有请求级限流，
 * 任何新账号都能无限调用形象照 / 试穿 / 美甲 / 小说 / 图文，钱记在仓库主人头上。
 * 这个文件把「头像那两条路由」已有的固定窗口限流泛化成通用额度闸。
 *
 * 取向：**限流器自身故障一律放行**。额度闸是附加防护，不是鉴权——
 * Redis 抖一下就把用户的正常操作打死，比偶尔多花一次模型的钱更糟。
 */

/** key 的分段沿用全仓约定 `环境:业务:模块:功能:标识`。 */
export function quotaKey(env: string, scope: string, userId: string): string {
  return `${env}:quota:${scope}:${userId}`;
}

export const QUOTA_SCOPE = {
  /** 头像重画 / 上传（唯一的既有额度，key 与阈值都不能动）。 */
  agentAvatar: "agent:avatar",
  workflowPortrait: "workflow:portrait",
  workflowTryOn: "workflow:try-on",
  workflowNail: "workflow:nail",
  workflowNovel: "workflow:novel",
  workflowArticle: "workflow:article",
  /** 登录尝试计数，沿用既有 key；成功后清零。标识位是 identifier（UID/用户名）。 */
  authLoginFail: "auth:login-fail",
} as const;

export type QuotaScopeName = keyof typeof QUOTA_SCOPE;

/**
 * 各档位额度。全部放这里是为了调额度时只改一处。
 * 数字是保守起步值：宁可让重度用户先撞到 429，也不要让一个新账号在一小时内烧掉几百次调用。
 */
export const QUOTA_PRESETS: Readonly<Record<QuotaScopeName, { readonly limit: number; readonly windowSeconds: number }>> = {
  agentAvatar: { limit: 20, windowSeconds: 3600 },
  workflowPortrait: { limit: 20, windowSeconds: 3600 },
  workflowTryOn: { limit: 20, windowSeconds: 3600 },
  workflowNail: { limit: 20, windowSeconds: 3600 },
  workflowNovel: { limit: 10, windowSeconds: 3600 },
  workflowArticle: { limit: 30, windowSeconds: 3600 },
  // 撞库成本是「服务端 CPU」不是钱，窗口给短一点、次数给少一点：正常用户忘密码
  // 试几次不会被锁，脚本批量试就撞墙。
  authLoginFail: { limit: 10, windowSeconds: 900 },
};

export interface ConsumeQuotaArgs {
  readonly userId: string;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly scope: string;
  /**
   * 覆盖默认 key。**只有头像这一个正当用途**：它的计数器正在线上跑着，
   * 换成新格式等于给所有用户重置额度（见 `agents/ratelimit.ts`）。
   */
  readonly key?: string;
  /** 限流器自身出错时的留痕回调。不传就静默放行——静默是最后手段，路由上都传。 */
  readonly onError?: (error: unknown) => void;
}

/**
 * 记一次额度消耗，返回是否放行（`true` = 还在额度内）。
 *
 * 固定窗口计数，不滑动 —— 到点整批清零。**绝不能每次都续 TTL**：
 * 那样活跃用户的窗口永远不结束，等于没有限流。
 *
 * INCR 和 TTL 放在同一个 MULTI 里，一次往返同时拿到「这是第几次」和「窗口还剩多久」。
 * 只在 `ttl < 0` 时补 EXPIRE，覆盖两种情况：
 * - 窗口第一次（INCR 刚建出 key，还没有 TTL）；
 * - **key 把 TTL 丢了**（INCR 与 EXPIRE 之间进程挂掉、或那一条 EXPIRE 自己失败）。
 *   这种情况会让用户从此再也调不动，而且没有任何日志会提到它。
 */
export async function consumeQuota(redis: Redis, args: ConsumeQuotaArgs): Promise<boolean> {
  const env = process.env.NODE_ENV ?? "dev";
  const key = args.key ?? quotaKey(env, args.scope, args.userId);

  try {
    const replies = await redis.multi().incr(key).ttl(key).exec();
    // exec() 只有在 WATCH 冲突时才回 null，这里没有 WATCH；真回 null 也当「放行」处理。
    if (!replies) return true;
    const used = Number(replies[0]?.[1] ?? 0);
    const ttl = Number(replies[1]?.[1] ?? -1);

    if (ttl < 0) await redis.expire(key, args.windowSeconds);

    return used <= args.limit;
  } catch (error) {
    args.onError?.(error);
    return true;
  }
}

/** 按 {@link QUOTA_PRESETS} 的档位扣一次额度。路由上只需要给一个名字。 */
export async function consumeNamedQuota(
  redis: Redis,
  name: QuotaScopeName,
  userId: string,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const preset = QUOTA_PRESETS[name];
  return consumeQuota(redis, { scope: QUOTA_SCOPE[name], userId, ...preset, onError });
}

/**
 * 取一个「能用就用、不能用就返回 null」的 redis。
 *
 * 没配 `REDIS_URL` 时 `getRedis()` 会抛（见 `packages/db/src/redis.ts`），而额度闸是
 * 附加防护，不该让「没配 redis」把正常请求打成 500。返回 null 时调用方按放行处理。
 * 单测不传 redis 走的也是这条路径——闸门默认开，测试不需要为每个用例准备计数器。
 */
export function optionalRedis(): Redis | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/**
 * 登录尝试计数的 key。登录成功后要按**同一个 key** 把计数删掉，
 * 所以 env 的拼法只在这里出现一次。
 */
export function loginFailQuotaKey(identifier: string): string {
  return quotaKey(process.env.NODE_ENV ?? "dev", QUOTA_SCOPE.authLoginFail, identifier);
}

/** 超额时统一的响应体。与头像现有的 429 同一句话，前端不用区分是哪条业务线。 */
export const QUOTA_EXCEEDED_MESSAGE = "操作过于频繁，请稍后再试";
