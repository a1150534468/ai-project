import { describe, expect, it, vi } from "vitest";
import {
  consumeNamedQuota,
  consumeQuota,
  QUOTA_EXCEEDED_MESSAGE,
  QUOTA_PRESETS,
  QUOTA_SCOPE,
  quotaKey,
} from "./quota.js";

/**
 * 与 `agents/ratelimit.test.ts` 同形状的假 Redis：只实现 `MULTI(INCR, TTL) / EXEC`
 * 和 `EXPIRE`，把计数与 TTL 分开存，每条用例可以直接把 Redis 摆成想验的那个样子
 * （已经用了 3 次 / TTL 丢了 / 计数刚好卡在额度上）。`ttl = -1` 是 Redis 的语义：
 * key 在，但没有过期时间。
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
    get ttl() {
      return currentTtl;
    },
  };
}

const onError = () => undefined;

describe("quotaKey", () => {
  it("按全仓约定分段：环境:quota:scope:标识", () => {
    expect(quotaKey("prod", "workflow:portrait", "u1")).toBe("prod:quota:workflow:portrait:u1");
  });
});

describe("consumeQuota", () => {
  it("未超限放行，并在第一次把 TTL 钉上", async () => {
    const f = fakeRedis();

    await expect(consumeQuota(f.redis, { scope: QUOTA_SCOPE.workflowNovel, userId: "u1", limit: 10, windowSeconds: 3600, onError })).resolves.toBe(true);

    expect(f.expire).toHaveBeenCalledWith(expect.stringContaining("u1"), 3600);
    expect(f.ttl).toBe(3600);
  });

  it("第 N 次放行，第 N+1 次拒", async () => {
    const f = fakeRedis({ count: 19, ttl: 1800 });

    await expect(consumeNamedQuota(f.redis, "workflowPortrait", "u1", onError)).resolves.toBe(true); // 第 20 次
    await expect(consumeNamedQuota(f.redis, "workflowPortrait", "u1", onError)).resolves.toBe(false); // 第 21 次
  });

  // 每次都续 TTL 的话活跃用户的窗口永远不结束，限流形同虚设
  it("窗口中间不碰 TTL", async () => {
    const f = fakeRedis({ count: 3, ttl: 1800 });

    await consumeNamedQuota(f.redis, "workflowTryOn", "u1", onError);

    expect(f.expire).not.toHaveBeenCalled();
    expect(f.ttl).toBe(1800);
  });

  // 计数在、TTL 没了 ⇒ 用户从此再也调不动。每次顺手体检并重新钉上。
  it("TTL 丢了会被重新钉上，不让用户被永久锁死", async () => {
    const f = fakeRedis({ count: 7, ttl: -1 });

    await expect(consumeNamedQuota(f.redis, "workflowNail", "u1", onError)).resolves.toBe(true);

    expect(f.expire).toHaveBeenCalledWith(expect.stringContaining("u1"), 3600);
    expect(f.ttl).toBe(3600);
  });

  it("EXEC 回 null 时放行", async () => {
    const redis = {
      multi: () => {
        const chain = { incr: () => chain, ttl: () => chain, exec: async () => null };
        return chain;
      },
      expire: vi.fn(),
    } as never;

    await expect(consumeNamedQuota(redis, "workflowArticle", "u1", onError)).resolves.toBe(true);
  });

  // Redis 挂了不该把用户的正常操作打死，所以失败方向是放行，但要留痕
  it("Redis 抛错时放行并调用 onError", async () => {
    const boom = new Error("ECONNREFUSED");
    const redis = {
      multi: () => {
        const chain = { incr: () => chain, ttl: () => chain, exec: async () => { throw boom; } };
        return chain;
      },
      expire: vi.fn(),
    } as never;
    const onErrorSpy = vi.fn();

    await expect(consumeNamedQuota(redis, "workflowArticle", "u1", onErrorSpy)).resolves.toBe(true);

    expect(onErrorSpy).toHaveBeenCalledWith(boom);
  });
});

describe("QUOTA_PRESETS", () => {
  it("每个成本型端点都有一档额度", () => {
    for (const name of Object.keys(QUOTA_SCOPE) as (keyof typeof QUOTA_SCOPE)[]) {
      const preset = QUOTA_PRESETS[name];
      expect(preset.limit, name).toBeGreaterThan(0);
      expect(preset.windowSeconds, name).toBeGreaterThan(0);
    }
  });

  it("超额文案与头像现有的 429 同一句", () => {
    expect(QUOTA_EXCEEDED_MESSAGE).toBe("操作过于频繁，请稍后再试");
  });
});
