import { describe, it, expect } from "vitest";
import { createRegistry, type RedisLike } from "./registry.js";

function fakeRedis(): RedisLike {
  const m = new Map<string, string>();
  return {
    async set(k, v) {
      m.set(k, v);
      return "OK";
    },
    async get(k) {
      return m.get(k) ?? null;
    },
    async del(k) {
      return m.delete(k) ? 1 : 0;
    },
  };
}

describe("connector registry", () => {
  it("set→get 返回实例 id", async () => {
    const reg = createRegistry(fakeRedis());
    await reg.setLocation("dev1", "inst-A");
    expect(await reg.getLocation("dev1")).toBe("inst-A");
  });

  it("clear 后 get 为 null", async () => {
    const reg = createRegistry(fakeRedis());
    await reg.setLocation("dev1", "inst-A");
    await reg.clearLocation("dev1");
    expect(await reg.getLocation("dev1")).toBeNull();
  });

  it("只允许当前 owner 清理 location，避免旧连接误删新连接", async () => {
    const reg = createRegistry(fakeRedis());
    await reg.setLocation("dev1", "inst-A");

    expect(await reg.clearLocationIfOwner("dev1", "inst-B")).toBe(false);
    expect(await reg.getLocation("dev1")).toBe("inst-A");

    expect(await reg.clearLocationIfOwner("dev1", "inst-A")).toBe(true);
    expect(await reg.getLocation("dev1")).toBeNull();
  });

  it("记录并清理在途工具调用 owner", async () => {
    const reg = createRegistry(fakeRedis());
    await reg.setPendingOwner("invoke-1", "inst-A", 30);
    expect(await reg.getPendingOwner("invoke-1")).toBe("inst-A");

    await reg.clearPendingOwner("invoke-1");
    expect(await reg.getPendingOwner("invoke-1")).toBeNull();
  });
});
