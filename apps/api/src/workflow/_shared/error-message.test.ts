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
    expect(errorMessageOrFallback(null, "生成失败，请稍后重试", 3)).toBe("生成失败，请稍后重试");
  });

  it("上游异常自带中文 message 时透传，不套兜底文案", () => {
    class UpstreamRejectedError extends Error {
      constructor() {
        super("上游模型拒绝了这次请求");
        this.name = "UpstreamRejectedError";
      }
    }
    expect(errorMessageOrFallback(new UpstreamRejectedError(), "人像生成失败", 300)).toBe("上游模型拒绝了这次请求");
  });
});
