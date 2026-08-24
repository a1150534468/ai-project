import { describe, expect, it } from "vitest";
import { estimateInputTokens, estimateTextTokens } from "./token-estimate.js";

describe("token 估算口径", () => {
  it("按字符数 / 3 向上取整", () => {
    expect(estimateTextTokens("abcd")).toBe(2);
    expect(estimateTextTokens("abc")).toBe(1);
  });

  it("空文本也至少算 1 个 token（下限保证计费不为 0）", () => {
    expect(estimateTextTokens("")).toBe(1);
  });

  it("提示词形状用空行拼接后再估算", () => {
    // "sys" + "\n\n" + "user" = 9 字符 → ceil(9 / 3) = 3
    expect(estimateInputTokens("sys", "user")).toBe(3);
    expect(estimateInputTokens("sys", "user")).toBe(estimateTextTokens("sys\n\nuser"));
  });
});
