import { describe, expect, it, vi } from "vitest";
import {
  ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS,
  ARTICLE_RETRY_MAX_ATTEMPTS,
  articleWorkflowRetryDelayMs,
  isRetryableArticleWorkflowError,
  withArticleWorkflowRetry,
} from "./article-workflow-retry.js";
import { ImageGenerationUpstreamError } from "../_shared/image-service.js";

function statusError(status: number): Error {
  return Object.assign(new Error(`upstream ${status}`), { status });
}

describe("article-workflow retry", () => {
  it("retries transport-level flakes but not quota or permission failures", () => {
    // undici 掐连接时抛的正是 TypeError("terminated")，实测生图时出现过
    const terminated = new TypeError("terminated");
    expect(isRetryableArticleWorkflowError(terminated)).toBe(true);
    expect(isRetryableArticleWorkflowError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableArticleWorkflowError(statusError(429))).toBe(true);
    expect(isRetryableArticleWorkflowError(statusError(500))).toBe(true);
    expect(isRetryableArticleWorkflowError(statusError(529))).toBe(true);

    // 额度耗尽的 403：退避几秒不会让额度回来，只会把失败原因往后推
    expect(isRetryableArticleWorkflowError(statusError(403))).toBe(false);
    expect(isRetryableArticleWorkflowError(statusError(400))).toBe(false);
    // 409 是冲突，重试只会再冲突一次
    expect(isRetryableArticleWorkflowError(statusError(409))).toBe(false);
    // 未分类的普通错误不猜：宁可直接失败让用户看到原因
    expect(isRetryableArticleWorkflowError(new Error("db down"))).toBe(false);
    expect(isRetryableArticleWorkflowError(null)).toBe(false);
  });

  it("defers to image-service classification instead of re-deriving it", () => {
    // moderation 是 400 但绝不该重试；这条判定只存在于 image-service 里
    const moderation = new ImageGenerationUpstreamError(400, "content_policy violation");
    expect(moderation.retryable).toBe(false);
    expect(isRetryableArticleWorkflowError(moderation)).toBe(false);

    const upstream = new ImageGenerationUpstreamError(503, "service unavailable");
    expect(upstream.retryable).toBe(true);
    expect(isRetryableArticleWorkflowError(upstream)).toBe(true);

    // 401/403 在 image-service 里归为 authentication，同样不重试
    expect(isRetryableArticleWorkflowError(new ImageGenerationUpstreamError(403, "denied"))).toBe(false);
  });

  it("backs off exponentially and honors the configured base", () => {
    expect(articleWorkflowRetryDelayMs(1)).toBe(2_000);
    expect(articleWorkflowRetryDelayMs(2)).toBe(4_000);
    // 上限封顶，不会退避到分钟级
    expect(articleWorkflowRetryDelayMs(10)).toBe(20_000);
    // 测试环境把退避归零，只验次数不真等
    expect(articleWorkflowRetryDelayMs(3, { ARTICLE_WORKFLOW_RETRY_BASE_MS: "0" })).toBe(0);
  });

  it("succeeds on a later attempt without surfacing the flake", async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const sleep = vi.fn(async () => {});

    const result = await withArticleWorkflowRetry({ work, onRetry, sleep });

    expect(result).toBe("ok");
    expect(work).toHaveBeenCalledTimes(3);
    // 进度文案要能说清这是第几次重试
    expect(onRetry.mock.calls.map((call) => call[1])).toEqual([2, 3]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("caps image attempts lower than text so a charged image can't burn three upstream calls", async () => {
    // gptimage 网关 ~60s 断连，断连时上游可能已经出图；扣费只发生一次，放大要封顶
    expect(ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS).toBeLessThan(ARTICLE_RETRY_MAX_ATTEMPTS);

    const work = vi.fn(async () => {
      throw new TypeError("terminated");
    });
    await expect(withArticleWorkflowRetry({
      work,
      maxAttempts: ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS,
      sleep: async () => {},
    })).rejects.toThrow("terminated");
    expect(work).toHaveBeenCalledTimes(ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS);
  });

  it("stops at the attempt ceiling and rethrows the last error", async () => {
    const work = vi.fn(async () => {
      throw statusError(503);
    });

    await expect(withArticleWorkflowRetry({ work, sleep: async () => {} })).rejects.toThrow("upstream 503");
    expect(work).toHaveBeenCalledTimes(ARTICLE_RETRY_MAX_ATTEMPTS);
  });

  it("fails fast on a non-retryable error without sleeping", async () => {
    const work = vi.fn(async () => {
      throw statusError(403);
    });
    const sleep = vi.fn(async () => {});

    await expect(withArticleWorkflowRetry({ work, sleep })).rejects.toThrow("upstream 403");
    // 一次就抛：额度型失败不该让用户白等退避
    expect(work).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
