import { describe, expect, it, vi } from "vitest";
import { createStaleScanner } from "./stale-scanner.js";

function fakeRedis(result: "OK" | null | Error) {
  return {
    set: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe("stale scanner", () => {
  it("拿到锁才跑 scan，且锁参数是 EX 55 NX", async () => {
    const redis = fakeRedis("OK");
    const scan = vi.fn(async () => 1);
    const scanner = createStaleScanner({ lockKey: "k", redis: redis as never, intervalMs: 1000, scan });
    await scanner.tick();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("k", "1", "EX", 55, "NX");
  });

  it("拿不到锁跳过本轮", async () => {
    const scan = vi.fn(async () => 1);
    const scanner = createStaleScanner({ lockKey: "k", redis: fakeRedis(null) as never, intervalMs: 1000, scan });
    await scanner.tick();
    expect(scan).not.toHaveBeenCalled();
  });

  it("redis 抛错按没拿到锁处理，不往外抛", async () => {
    const scan = vi.fn(async () => 1);
    const scanner = createStaleScanner({ lockKey: "k", redis: fakeRedis(new Error("down")) as never, intervalMs: 1000, scan });
    await expect(scanner.tick()).resolves.toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
  });

  it("lockKey 为 null 时不碰 redis、直接扫描（sticker 的无锁模式）", async () => {
    const scan = vi.fn(async () => 1);
    const scanner = createStaleScanner({ lockKey: null, intervalMs: 1000, scan });
    await scanner.tick();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("scan 抛错走 onError 且 tick 不抛（定时器不受影响）", async () => {
    const onError = vi.fn();
    const scanner = createStaleScanner({
      lockKey: null,
      intervalMs: 1000,
      scan: async () => {
        throw new Error("boom");
      },
      onError,
    });
    await expect(scanner.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
