import { describe, it, expect, vi } from "vitest";
import { consumeSchedAiQuota, SCHED_AI_QUOTA_PER_HOUR } from "./ratelimit.js";

function fakeRedis(seq: number[]) {
  let i = 0;
  return { incr: vi.fn().mockImplementation(() => Promise.resolve(seq[i++])), expire: vi.fn().mockResolvedValue(1) };
}

describe("consumeSchedAiQuota", () => {
  it("首次调用 incr=1 时设置 TTL 并放行", async () => {
    const redis = fakeRedis([1]);
    const ok = await consumeSchedAiQuota(redis as never, "u1");
    expect(ok).toBe(true);
    expect(redis.expire).toHaveBeenCalledOnce();
  });

  it("未超额放行、超额拦截，且非首次不再设 TTL", async () => {
    const redis = fakeRedis([SCHED_AI_QUOTA_PER_HOUR, SCHED_AI_QUOTA_PER_HOUR + 1]);
    expect(await consumeSchedAiQuota(redis as never, "u1")).toBe(true);
    expect(await consumeSchedAiQuota(redis as never, "u1")).toBe(false);
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
