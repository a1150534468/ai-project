import { describe, it, expect, vi } from "vitest";
import { acquireSessionLock } from "../lock.js";

function fakeRedis(firstOk: boolean) {
  return {
    set: vi.fn(async () => (firstOk ? "OK" : null)),
    get: vi.fn(async () => (firstOk ? `token` : null)),
    del: vi.fn(async () => 1),
  } as never;
}

describe("会话锁", () => {
  it("拿到锁返回 release 函数", async () => {
    const release = await acquireSessionLock(fakeRedis(true), "s1");
    expect(typeof release).toBe("function");
    await release!();
  });
  it("锁被占用返回 null", async () => {
    const release = await acquireSessionLock(fakeRedis(false), "s1");
    expect(release).toBeNull();
  });
});
