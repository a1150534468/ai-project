import { describe, expect, it } from "vitest";
import { errorMessageOrFallback } from "./error-message.js";

describe("errorMessageOrFallback", () => {
  it("Error 有话说就用它的 message", () => {
    expect(errorMessageOrFallback(new Error("上游 502"), "生成失败")).toBe("上游 502");
  });

  it("非 Error 一律走兜底，不做 String(err)", () => {
    expect(errorMessageOrFallback(undefined, "生成失败")).toBe("生成失败");
    expect(errorMessageOrFallback("裸字符串", "生成失败")).toBe("生成失败");
    expect(errorMessageOrFallback({ token: "sk-secret" }, "生成失败")).toBe("生成失败");
  });

  it("message 空白也走兜底", () => {
    expect(errorMessageOrFallback(new Error(""), "生成失败")).toBe("生成失败");
    expect(errorMessageOrFallback(new Error("   "), "生成失败")).toBe("生成失败");
  });

  it("默认截断 500 字，可按域覆盖", () => {
    const long = "x".repeat(900);
    expect(errorMessageOrFallback(new Error(long), "生成失败")).toHaveLength(500);
    expect(errorMessageOrFallback(new Error(long), "生成失败", 300)).toHaveLength(300);
  });

  it("兜底文案本身不受截断长度影响", () => {
    expect(errorMessageOrFallback(null, "余额不足，请充值", 3)).toBe("余额不足，请充值");
  });

  it("InsufficientBalanceError 的 message 本就是中文提示，透传即为原提示语", () => {
    // packages/billing 里 message 固定为「余额不足，请充值」，
    // 所以 portrait / try-on 原先那条 instanceof 分支是重复的。
    class InsufficientBalanceError extends Error {
      constructor() {
        super("余额不足，请充值");
        this.name = "InsufficientBalanceError";
      }
    }
    expect(errorMessageOrFallback(new InsufficientBalanceError(), "人像生成失败", 300)).toBe("余额不足，请充值");
  });
});
