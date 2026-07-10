import { describe, it, expect } from "vitest";
import { signAdminToken, verifyAdminToken } from "./token.js";

const secret = "y".repeat(32);

describe("admin token", () => {
  it("签发可被验证、返回 adminId", () => {
    const t = signAdminToken("admin1", secret);
    expect(verifyAdminToken(t, secret)).toBe("admin1");
  });
  it("错误 secret 拒绝", () => {
    const t = signAdminToken("admin1", secret);
    expect(verifyAdminToken(t, "z".repeat(32))).toBeNull();
  });
  it("过期拒绝", () => {
    const t = signAdminToken("admin1", secret, -1);
    expect(verifyAdminToken(t, secret)).toBeNull();
  });
  it("用户 token 形态(无 admin. 前缀)被拒", () => {
    expect(verifyAdminToken("admin1.123.sig", secret)).toBeNull();
  });
});
