import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../token.js";

const secret = "test-secret-at-least-32-bytes-long-xxxxx";

describe("session token", () => {
  it("签发后能验回同一 userId", () => {
    const t = signToken("user_123", secret);
    expect(verifyToken(t, secret)).toBe("user_123");
  });
  it("篡改 token 验证失败返回 null", () => {
    const t = signToken("user_123", secret);
    expect(verifyToken(t + "x", secret)).toBeNull();
  });
  it("错误密钥验证失败返回 null", () => {
    const t = signToken("user_123", secret);
    expect(verifyToken(t, "another-secret-at-least-32-bytes-long-yy")).toBeNull();
  });
  it("拒绝过期或非数字过期时间", () => {
    expect(verifyToken(signToken("user_123", secret, -1), secret)).toBeNull();
    expect(verifyToken(signToken("user_123", secret, Number.NaN), secret)).toBeNull();
  });
});
