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
  it("权限清单含 5 项，且与 admin 前端的联合类型一致", () => {
    // 计费/分销那批随 Phase 2 下线，MODEL_MANAGE 随「模型目录改配置驱动」下线。
    expect([...PERMISSIONS]).toEqual([
      "USER_MANAGE",
      "USER_DETAIL_VIEW",
      "ANNOUNCEMENT_MANAGE",
      "ADMIN_MANAGE",
      "KNOWLEDGE_MANAGE",
    ]);
  });
});
