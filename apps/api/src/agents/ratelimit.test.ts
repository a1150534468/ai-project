import { describe, it, expect, vi } from "vitest";
import { consumeAvatarQuota, avatarQuotaKey, AVATAR_QUOTA_PER_HOUR } from "./ratelimit.js";

function fakeRedis(initial = 0) {
  let count = initial;
  const expire = vi.fn(async () => 1);
  return {
    redis: { incr: vi.fn(async () => ++count), expire } as never,
    expire,
    get count() { return count; },
  };
}

describe("consumeAvatarQuota", () => {
  it("key 遵循 环境:业务:模块:功能:标识 规范", () => {
    expect(avatarQuotaKey("dev", "u1")).toBe("dev:agent:avatar:ratelimit:u1");
  });
  it("首次调用设置 TTL", async () => {
    const f = fakeRedis(0);
    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(true);
    expect(f.expire).toHaveBeenCalledWith(expect.stringContaining("u1"), 3600);
  });
  it("第 N 次仍放行，第 N+1 次拒绝", async () => {
    const f = fakeRedis(AVATAR_QUOTA_PER_HOUR - 1);
    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(true);   // 第 20 次
    await expect(consumeAvatarQuota(f.redis, "u1")).resolves.toBe(false);  // 第 21 次
  });
  it("非首次不重设 TTL（避免滑动窗口被无限续期）", async () => {
    const f = fakeRedis(3);
    await consumeAvatarQuota(f.redis, "u1");
    expect(f.expire).not.toHaveBeenCalled();
  });
});
