import { describe, it, expect } from "vitest";
import { acquireSkySlot, releaseSkySlot } from "./dub-concurrency.js";

// 极简假 redis：仅实现 incr/decr/expire，够信号量用
function fakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    async incr(k: string) { const v = (store.get(k) ?? 0) + 1; store.set(k, v); return v; },
    async decr(k: string) { const v = Math.max(0, (store.get(k) ?? 0) - 1); store.set(k, v); return v; },
    async expire(_k: string, _s: number) { return 1; },
  };
}

describe("dub-concurrency 信号量", () => {
  it("未达上限可获取，超限拒绝并回退计数", async () => {
    const r = fakeRedis();
    expect(await acquireSkySlot(r, 2)).toBe(true);
    expect(await acquireSkySlot(r, 2)).toBe(true);
    expect(await acquireSkySlot(r, 2)).toBe(false); // 第 3 个超限
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(2); // 回退后仍为 2
  });

  it("release 递减不为负", async () => {
    const r = fakeRedis();
    await acquireSkySlot(r, 2);
    await releaseSkySlot(r);
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(0);
    await releaseSkySlot(r); // 再减不为负
    expect(r.store.get("yunclaude:dub:sky:inflight")).toBe(0);
  });
});
