import { describe, it, expect } from "vitest";
import { can, type Session } from "./auth.js";

const sa: Session = { token: "t", adminId: "a", role: "super_admin", permissions: [] };
const plain: Session = { token: "t", adminId: "b", role: "admin", permissions: ["USER_MANAGE"] };

describe("can 权限门禁", () => {
  it("super_admin 永真", () => {
    expect(can(sa, "KNOWLEDGE_MANAGE")).toBe(true);
    expect(can(sa, "ADMIN_MANAGE")).toBe(true);
  });
  it("普通 admin 仅其授予集", () => {
    expect(can(plain, "USER_MANAGE")).toBe(true);
    expect(can(plain, "KNOWLEDGE_MANAGE")).toBe(false);
    expect(can(plain, "ADMIN_MANAGE")).toBe(false);
  });
  it("无 session 全 false", () => {
    expect(can(null, "USER_MANAGE")).toBe(false);
  });
});
