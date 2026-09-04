import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "./api.js";
import { saveSession, clearSession } from "./auth.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  clearSession();
  // jsdom 提供 sessionStorage；vitest 默认 node 环境需在 config 指定 jsdom（见 Task 9 注）
});

describe("admin api 客户端", () => {
  it("login 成功返回 session 字段", async () => {
    globalThis.fetch = mockFetch(200, { token: "tk", adminId: "a1", role: "admin", permissions: ["USER_MANAGE"] });
    const s = await api.login("u", "p");
    expect(s.token).toBe("tk");
    expect(s.permissions).toEqual(["USER_MANAGE"]);
  });
  it("401 抛 UnauthorizedError", async () => {
    saveSession({ token: "tk", adminId: "a", role: "admin", permissions: [] });
    globalThis.fetch = mockFetch(401, { error: "x" });
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.UnauthorizedError);
  });
  it("403 抛 ForbiddenError", async () => {
    saveSession({ token: "tk", adminId: "a", role: "admin", permissions: [] });
    globalThis.fetch = mockFetch(403, { error: "no perm" });
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.ForbiddenError);
  });
});
