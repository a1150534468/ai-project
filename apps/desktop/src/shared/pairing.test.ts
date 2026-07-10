import { describe, it, expect, vi } from "vitest";
import { login, pairDevice, type DeviceCredentialStore } from "./pairing.js";

function memStore(): DeviceCredentialStore {
  let v: { deviceId: string; token: string } | null = null;
  return {
    get: () => v,
    set: (credentials) => {
      v = credentials;
    },
  };
}

describe("pairing", () => {
  it("login 返回会话 token", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: "sess" }),
    })) as unknown as typeof fetch;
    expect(await login("http://api", "tester", "pw12345678", fetchFn)).toBe("sess");
  });

  it("login 失败抛错", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(login("http://api", "tester", "x", fetchFn)).rejects.toThrow();
  });

  it("pairDevice 配对并存 device token", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ deviceId: "dev1", token: "devtok" }),
    })) as unknown as typeof fetch;
    const store = memStore();
    const r = await pairDevice("http://api", "sess", "我的电脑", "win", store, fetchFn);
    expect(r.deviceId).toBe("dev1");
    expect(store.get()).toEqual({ deviceId: "dev1", token: "devtok" });
  });
});
