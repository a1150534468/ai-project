import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";

const options = (overrides: Partial<Parameters<typeof chunkText>[1]> = {}) => ({
  maxTokens: 4,
  overlapTokens: 1,
  maxChunks: 20,
  ...overrides,
});

describe("chunkText", () => {
  it("trim 后的短文本原样成为单块", () => {
    expect(chunkText("  hello world  ", options())).toEqual(["hello world"]);
  });

  it("空串和纯空白没有块", () => {
    expect(chunkText("", options())).toEqual([]);
    expect(chunkText(" \n\t ", options())).toEqual([]);
  });

  it("窗口按每 token 三个 UTF-16 code unit 计算", () => {
    const chunks = chunkText("0123456789abcdefghijkl", options({ overlapTokens: 0 }));
    expect(chunks).toEqual(["0123456789ab", "cdefghijkl"]);
  });

  it("相邻窗口精确重叠 overlapTokens × 3", () => {
    const chunks = chunkText("0123456789abcdefghijklmnop", options());
    expect(chunks[0]).toBe("0123456789ab");
    expect(chunks[1]).toBe("9abcdefghijk");
    expect(chunks[0].slice(-3)).toBe(chunks[1].slice(0, 3));
  });

  it("到 maxChunks 就停止", () => {
    expect(chunkText("x".repeat(100), options({ maxChunks: 3 }))).toHaveLength(3);
  });

  it("overlap 不小于窗口时仍逐个 code unit 前进", () => {
    expect(chunkText("abcdef", options({ maxTokens: 1, overlapTokens: 1, maxChunks: 4 }))).toEqual([
      "abc",
      "bcd",
      "cde",
      "def",
    ]);
  });

  it("纯空白窗口被跳过，但游标继续前进", () => {
    expect(chunkText("a      b", options({ maxTokens: 1, overlapTokens: 0 }))).toEqual(["a  ", " b"]);
  });

  it("继续使用 UTF-16 slice，保持既有块边界", () => {
    const chunks = chunkText("a😀bc", options({ maxTokens: 1, overlapTokens: 0 }));
    expect(chunks).toEqual(["a😀", "bc"]);
    expect(chunks[0]).toHaveLength(3);
  });
});
