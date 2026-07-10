import { describe, it, expect } from "vitest";
import { generateDeviceToken, hashToken } from "./token.js";

describe("device token", () => {
  it("生成的 token 高熵且每次不同", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });

  it("tokenHash 由 token 确定派生", () => {
    const { token, tokenHash } = generateDeviceToken();
    expect(hashToken(token)).toBe(tokenHash);
  });

  it("不同 token 哈希不同", () => {
    expect(hashToken("aaa")).not.toBe(hashToken("bbb"));
  });
});
