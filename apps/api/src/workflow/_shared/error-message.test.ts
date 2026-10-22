import { describe, expect, it } from "vitest";
import { errorMessage as kbErrorMessage } from "../../kb/indexer.js";
import { failureText as kbFailureText } from "../../kb/reaper.js";
import { safeErrorMessage as transcriptionRouteMessage } from "../transcription/transcription-route-helpers.js";
import { safeErrorMessage as transcriptionRunnerMessage } from "../transcription/transcription-task-runner.js";
import { errorMessageOrFallback } from "./error-message.js";
import { isUniqueConstraintError } from "./prisma-errors.js";

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

/**
 * 下面这组存在的理由：上面测的是共享实现自己，而 transcription 与 kb 曾经各留一份
 * 迁移前的实现，恰恰用了禁止的 `String(error)` —— 共享模块的注释让人误以为已经统一，
 * 结果是**测试通过而生产行为不同**。所以「非 Error 走 fallback」这条口径必须钉在
 * 每个域对外的那个函数上，只测共享实现覆盖不到它们。
 */
const nonErrors: { label: string; value: unknown }[] = [
  { label: "裸字符串", value: "上游炸了" },
  { label: "上游返回的裸对象", value: { code: "SERVER_ERROR", requestId: "req-1" } },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "数字", value: 500 },
];

describe("各域的 error→string 都必须走共享口径", () => {
  const cases = [
    { name: "transcription 路由层", fn: transcriptionRouteMessage, fallback: "转写任务处理失败" },
    { name: "transcription 执行层", fn: transcriptionRunnerMessage, fallback: "转写任务处理失败" },
    { name: "kb indexer", fn: kbErrorMessage, fallback: "Unknown error" },
    { name: "kb reaper", fn: kbFailureText, fallback: "Unknown error" },
  ];

  for (const { name, fn, fallback } of cases) {
    describe(name, () => {
      for (const { label, value } of nonErrors) {
        it(`非 Error 输入（${label}）走 fallback，不被原样泄进响应体`, () => {
          expect(fn(value)).toBe(fallback);
        });
      }

      it("Error 的 message 仍然透传（业务文案不丢）", () => {
        expect(fn(new Error("真实原因"))).toBe("真实原因");
      });
    });
  }
});

describe("isUniqueConstraintError", () => {
  it("只认 P2002", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isUniqueConstraintError({ code: "P2003" })).toBe(false);
  });

  it("非对象一律 false，不抛", () => {
    for (const value of [null, undefined, "P2002", 2002, new Error("P2002")]) {
      expect(isUniqueConstraintError(value)).toBe(false);
    }
  });
});
