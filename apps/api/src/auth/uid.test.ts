import { describe, it, expect, vi } from "vitest";
import { generateUid, generateUniqueUid, generatePrefixedUid, generateUniquePrefixedUid } from "./uid.js";

describe("generateUid", () => {
  it("总是 8 位数字、落在 10000000–99999999", () => {
    for (let i = 0; i < 200; i++) {
      const uid = generateUid();
      expect(uid).toMatch(/^[1-9]\d{7}$/);
      const n = Number(uid);
      expect(n).toBeGreaterThanOrEqual(10_000_000);
      expect(n).toBeLessThanOrEqual(99_999_999);
    }
  });
});

describe("generateUniqueUid", () => {
  it("撞号则重试直到不存在", async () => {
    const exists = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const uid = await generateUniqueUid(exists);
    expect(uid).toMatch(/^[1-9]\d{7}$/);
    expect(exists).toHaveBeenCalledTimes(2);
  });
  it("多次都撞则抛错", async () => {
    await expect(generateUniqueUid(async () => true)).rejects.toThrow(/冲突/);
  });
});

describe("generatePrefixedUid", () => {
  it("返回 <码>-<8位数字> 格式", () => {
    const uid = generatePrefixedUid("AB");
    expect(uid).toMatch(/^AB-\d{8}$/);
  });
});

describe("generateUniquePrefixedUid", () => {
  it("查重冲突时重试直到唯一", async () => {
    const seen = new Set<string>();
    let calls = 0;
    const uid = await generateUniquePrefixedUid("XY", async (u) => {
      calls++;
      if (calls === 1) return true; // 第一次假装已存在
      return seen.has(u);
    });
    expect(uid).toMatch(/^XY-\d{8}$/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
