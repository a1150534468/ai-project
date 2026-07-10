import { describe, it, expect, vi } from "vitest";
import { dubParseRateKey, consumeDubParseQuota } from "./dub-parse-ratelimit.js";

describe("dub-parse-ratelimit", () => {
  it("key 遵循 环境:业务:模块:功能:标识", () => {
    expect(dubParseRateKey("prod", "u1")).toBe("prod:dub:parse:ratelimit:u1");
  });

  it("首次 INCR==1 设 TTL 且放行", async () => {
    const redis = { incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) };
    const ok = await consumeDubParseQuota(redis as never, "u1", 20);
    expect(ok).toBe(true);
    expect(redis.expire).toHaveBeenCalledWith(expect.any(String), 3600);
  });

  it("超过配额拒绝", async () => {
    const redis = { incr: vi.fn().mockResolvedValue(21), expire: vi.fn() };
    expect(await consumeDubParseQuota(redis as never, "u1", 20)).toBe(false);
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
