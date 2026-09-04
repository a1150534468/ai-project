import { describe, it, expect } from "vitest";
import { hasPermission, PERMISSIONS } from "./permissions.js";

describe("权限", () => {
  it("super_admin 拥有任意权限", () => {
    expect(hasPermission({ role: "super_admin", permissions: [] }, "USER_MANAGE")).toBe(true);
    expect(hasPermission({ role: "super_admin", permissions: [] }, "ADMIN_MANAGE")).toBe(true);
  });
  it("admin 只有被授予的", () => {
    const a = { role: "admin", permissions: ["USER_MANAGE"] };
    expect(hasPermission(a, "USER_MANAGE")).toBe(true);
    expect(hasPermission(a, "KNOWLEDGE_MANAGE")).toBe(false);
    expect(hasPermission(a, "ADMIN_MANAGE")).toBe(false);
  });
  it("权限清单含 6 项", () => {
    expect(PERMISSIONS).toHaveLength(6);
    expect(PERMISSIONS).toContain("USER_DETAIL_VIEW");
  });
});
