import { describe, it, expect } from "vitest";
import { chunkText, WECHAT_MAX_CHARS } from "./chunk.js";

describe("chunkText", () => {
  it("短文本返回单块", () => {
    expect(chunkText("你好")).toEqual(["你好"]);
  });
  it("空文本返回单个空块（保证至少发一次）", () => {
    expect(chunkText("")).toEqual([""]);
  });
  it("超长文本按上限切分且不丢字符", () => {
    const s = "a".repeat(WECHAT_MAX_CHARS * 2 + 5);
    const parts = chunkText(s);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= WECHAT_MAX_CHARS)).toBe(true);
    expect(parts.join("")).toBe(s);
  });
});
