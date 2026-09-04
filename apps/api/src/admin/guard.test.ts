import { describe, it, expect } from "vitest";
import { checkAdminAuth } from "./guard.js";

const adminFix = { id: "a1", role: "admin", permissions: ["USER_MANAGE"], disabled: false };

describe("checkAdminAuth", () => {
  it("无 token → 401", async () => {
    const r = await checkAdminAuth(null, async () => adminFix, "USER_MANAGE");
    expect(r.ok).toBe(false);
    expect(r.code).toBe(401);
  });

  it("token 无效(解析不出 adminId) → 401", async () => {
    const r = await checkAdminAuth("bad", async () => null, "USER_MANAGE");
    expect(r.code).toBe(401);
  });

  it("admin 不存在/禁用 → 401", async () => {
    const r = await checkAdminAuth("a1", async () => ({ ...adminFix, disabled: true }), "USER_MANAGE");
    expect(r.code).toBe(401);
  });

  it("权限不足 → 403", async () => {
    const r = await checkAdminAuth("a1", async () => adminFix, "ADMIN_MANAGE");
    expect(r.code).toBe(403);
  });

  it("有权限 → ok + 带 admin", async () => {
    const r = await checkAdminAuth("a1", async () => adminFix, "USER_MANAGE");
    expect(r.ok).toBe(true);
    expect(r.admin?.id).toBe("a1");
  });
});
