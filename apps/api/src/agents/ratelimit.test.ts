import { describe, expect, it, vi } from "vitest";
import { AVATAR_QUOTA_PER_HOUR, avatarQuotaKey, consumeAvatarQuota } from "./ratelimit.js";

/**
 * 一个刚好够用的假 Redis：只实现 `MULTI(INCR, TTL) / EXEC` 和 `EXPIRE`，
 * 并且**把计数和 TTL 分开当状态存**，这样每条用例可以直接把 Redis 摆成想验的那个样子
 * （已经用了 3 次、TTL 还剩 1800 秒 / TTL 莫名丢了 / 计数刚好卡在额度上）。
 *
 * `ttl = -1` 就是 Redis 的语义：key 在，但没有过期时间。
 */
function fakeRedis({ count = 0, ttl = -1 }: { count?: number; ttl?: number } = {}) {
  let currentCount = count;
  let currentTtl = ttl;

  const expire = vi.fn(async (_key: string, seconds: number) => {
    currentTtl = seconds;
    return 1;
  });

  const multi = vi.fn(() => {
    const queued: (() => number)[] = [];
    const chain = {
      incr: () => {
        queued.push(() => ++currentCount);
        return chain;
      },
      ttl: () => {
        queued.push(() => currentTtl);
        return chain;
      },
      exec: async () => queued.map((run) => [null, run()]),
    };
    return chain;
  });

  return {
    redis: { multi, expire } as never,
    expire,
    multi,
    get ttl() {
      return currentTtl;
    },
  };
}

describe("avatarQuotaKey", () => {
  it("按全仓约定分段：环境:业务:模块:功能:标识", () => {
    expect(avatarQuotaKey("dev", "u1")).toBe("dev:agent:avatar:ratelimit:u1");
  });
});

describe("consumeAvatarQuota", () => {
  it("窗口第一次：放行，并把 TTL 钉成一小时", async () => {
    const f = fakeRedis();

    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(true);

    expect(f.expire).toHaveBeenCalledWith(expect.stringContaining("u1"), 3600);
  });

  // 每次都续 TTL 的话，活跃用户的窗口永远不结束，限流就形同虚设
  it("窗口中间不碰 TTL", async () => {
    const f = fakeRedis({ count: 3, ttl: 1800 });

    await consumeAvatarQuota(f.redis, "u1");

    expect(f.expire).not.toHaveBeenCalled();
    expect(f.ttl).toBe(1800);
  });

  // 这是旧实现的事故：只在计数为 1 时设 TTL，那一条 EXPIRE 一旦没执行成功，
  // 这个 key 就永久没有过期时间，用户从此再也画不了头像，而且不会有任何报错
  it("TTL 丢了会被重新钉上，不让用户被永久锁死", async () => {
    const f = fakeRedis({ count: 7, ttl: -1 });

    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(true);

    expect(f.expire).toHaveBeenCalledWith(expect.stringContaining("u1"), 3600);
    expect(f.ttl).toBe(3600);
  });

  it("第 N 次放行，第 N+1 次拒", async () => {
    const f = fakeRedis({ count: AVATAR_QUOTA_PER_HOUR - 1, ttl: 1800 });

    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(true); // 第 20 次
    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(false); // 第 21 次
  });

  // 限流器自己坏了不该把用户的正常操作打死，所以失败方向是放行
  it("EXEC 回 null 时放行", async () => {
    const redis = {
      multi: () => {
        const chain = { incr: () => chain, ttl: () => chain, exec: async () => null };
        return chain;
      },
      expire: vi.fn(),
    } as never;

    await expect(consumeAvatarQuota(redis, "u1")).resolves.toBe(true);
  });
});
