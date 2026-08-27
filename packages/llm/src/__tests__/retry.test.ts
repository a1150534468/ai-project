import { describe, expect, it, vi } from "vitest";
import { defaultRetryableLlmError, llmRetryDelayMs, waitCancellable, withLlmRetry } from "../retry.js";

describe("defaultRetryableLlmError", () => {
  it("408/409/429/5xx 可重试，4xx 其余不可", () => {
    expect(defaultRetryableLlmError({ status: 408 })).toBe(true);
    expect(defaultRetryableLlmError({ status: 409 })).toBe(true);
    expect(defaultRetryableLlmError({ status: 429 })).toBe(true);
    expect(defaultRetryableLlmError({ status: 500 })).toBe(true);
    expect(defaultRetryableLlmError({ status: 503 })).toBe(true);
    expect(defaultRetryableLlmError({ status: 400 })).toBe(false);
    expect(defaultRetryableLlmError({ status: 401 })).toBe(false);
    expect(defaultRetryableLlmError({ status: 404 })).toBe(false);
  });

  it("网络类错误码可重试", () => {
    expect(defaultRetryableLlmError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true);
    expect(defaultRetryableLlmError({ code: "ECONNREFUSED" })).toBe(true);
    expect(defaultRetryableLlmError({ code: "ENOTFOUND" })).toBe(true);
    expect(defaultRetryableLlmError({ code: "EAI_AGAIN" })).toBe(true);
    // code 只需包含 "timeout"，覆盖 undici 的 UND_ERR_*_TIMEOUT 这类。
    expect(defaultRetryableLlmError({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
    // 现状：ETIMEDOUT 既不在名单里，也不含子串 "timeout"（是 "timed"），因此不可
    // 重试。这里钉住的是既有行为，不是在为它背书——要改得单独提，别在收敛时顺手改。
    expect(defaultRetryableLlmError({ code: "ETIMEDOUT" })).toBe(false);
    expect(defaultRetryableLlmError({ code: "EPERM" })).toBe(false);
  });

  it("name 含 connection / timeout 可重试，大小写不敏感", () => {
    expect(defaultRetryableLlmError({ name: "APIConnectionError" })).toBe(true);
    expect(defaultRetryableLlmError({ name: "ConnectionTimeout" })).toBe(true);
    expect(defaultRetryableLlmError({ name: "TypeError" })).toBe(false);
  });

  it("非对象错误一律不可重试", () => {
    expect(defaultRetryableLlmError(null)).toBe(false);
    expect(defaultRetryableLlmError(undefined)).toBe(false);
    expect(defaultRetryableLlmError("connection reset")).toBe(false);
    expect(defaultRetryableLlmError(429)).toBe(false);
  });

  it("status 不是数字时落回 name / code 判定", () => {
    expect(defaultRetryableLlmError({ status: "429" })).toBe(false);
    expect(defaultRetryableLlmError({ status: "429", code: "ECONNRESET" })).toBe(true);
  });
});

describe("llmRetryDelayMs", () => {
  it("3 倍指数退避且封顶", () => {
    expect(llmRetryDelayMs(1, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(5_000);
    expect(llmRetryDelayMs(2, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(15_000);
    expect(llmRetryDelayMs(3, { baseDelayMs: 5_000, capDelayMs: 30_000 })).toBe(30_000);
  });

  it("缺省 base 5s / cap 30s / factor 3", () => {
    expect(llmRetryDelayMs(1)).toBe(5_000);
    expect(llmRetryDelayMs(2)).toBe(15_000);
    expect(llmRetryDelayMs(3)).toBe(30_000);
    expect(llmRetryDelayMs(4)).toBe(30_000);
  });

  it("attempt <= 1 都取 base，不会算出小于 base 的退避", () => {
    expect(llmRetryDelayMs(0, { baseDelayMs: 5_000 })).toBe(5_000);
    expect(llmRetryDelayMs(-3, { baseDelayMs: 5_000 })).toBe(5_000);
  });

  it("base 非有限值或为负时回退缺省——调用方可以直接传 Number(env.X)", () => {
    expect(llmRetryDelayMs(1, { baseDelayMs: Number.NaN })).toBe(5_000);
    expect(llmRetryDelayMs(1, { baseDelayMs: -1 })).toBe(5_000);
    expect(llmRetryDelayMs(1, { capDelayMs: Number.NaN })).toBe(5_000);
  });

  it("base 超过 cap 时先被 cap 夹住", () => {
    expect(llmRetryDelayMs(1, { baseDelayMs: 90_000, capDelayMs: 30_000 })).toBe(30_000);
  });

  it("base 为 0 是合法配置（测试里用于免等待）", () => {
    expect(llmRetryDelayMs(3, { baseDelayMs: 0 })).toBe(0);
  });
});

describe("waitCancellable", () => {
  it("正常等待后 resolve", async () => {
    await expect(waitCancellable(1)).resolves.toBeUndefined();
  });

  it("已 abort 的 signal 立刻抛 signal.reason", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    controller.abort(reason);
    await expect(waitCancellable(1_000, controller.signal)).rejects.toBe(reason);
  });

  it("等待期间 abort 立刻抛出", async () => {
    const controller = new AbortController();
    const pending = waitCancellable(10_000, controller.signal);
    const reason = new Error("cancelled mid-wait");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("withLlmRetry", () => {
  it("可重试错误重试到成功", async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce("ok");
    await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("不可重试错误直接抛", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("signal abort 后不再重试", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject({ status: 500 });
    });
    await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 0, signal: controller.signal }))
      .rejects.toEqual({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("用满次数后抛最后一次的错误", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("把第几次尝试传给 fn", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValueOnce("ok");
    await expect(withLlmRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it("自定义 retryable 覆盖默认判定——领域错误由调用方组合", async () => {
    class DomainError extends Error {}
    const fn = vi.fn().mockRejectedValue(Object.assign(new DomainError("bad model"), { status: 500 }));
    await expect(withLlmRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 0,
      retryable: (error) => !(error instanceof DomainError) && defaultRetryableLlmError(error),
    })).rejects.toBeInstanceOf(DomainError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxAttempts 非正整数时回退缺省 3，不会无限重试", async () => {
    const nan = vi.fn().mockRejectedValue({ status: 500 });
    await expect(withLlmRetry(nan, { maxAttempts: Number.NaN, baseDelayMs: 0 })).rejects.toEqual({ status: 500 });
    expect(nan).toHaveBeenCalledTimes(3);

    const zero = vi.fn().mockRejectedValue({ status: 500 });
    await expect(withLlmRetry(zero, { maxAttempts: 0, baseDelayMs: 0 })).rejects.toEqual({ status: 500 });
    expect(zero).toHaveBeenCalledTimes(3);

    const fractional = vi.fn().mockRejectedValue({ status: 500 });
    await expect(withLlmRetry(fractional, { maxAttempts: 2.5, baseDelayMs: 0 })).rejects.toEqual({ status: 500 });
    expect(fractional).toHaveBeenCalledTimes(3);
  });

  it("maxAttempts=1 表示不重试", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500 });
    await expect(withLlmRetry(fn, { maxAttempts: 1, baseDelayMs: 0 })).rejects.toEqual({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("退避等待期间 abort，抛出的是 signal.reason 而不是上一次的错误", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const fn = vi.fn().mockImplementation(() => {
      setTimeout(() => controller.abort(reason), 0);
      return Promise.reject({ status: 500 });
    });
    await expect(withLlmRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10_000,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
