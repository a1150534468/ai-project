/**
 * 图文工作流的系统兜底重试。
 *
 * 只兜「重试一下真有可能好」的抖动：超时、限流、上游 5xx、连接被掐。
 * 额度/权限型 403 与参数型 4xx 不重试——退避几秒不会让额度回来，
 * 白等还把失败原因往后推；这类失败交给用户手动重试（额度恢复后一键重跑）。
 */

import { classifyImageGenerationError } from "../_shared/image-service.js";

export const ARTICLE_RETRY_MAX_ATTEMPTS = 3;
/**
 * 生图的尝试上限比文本低一档。
 *
 * gptimage 网关约 60s 主动断连，而单张图真实耗时 40-75s，所以 `terminated` 是**歧义失败**：
 * 连接断了，但上游很可能已经出图并已计费。扣费在重试之外（一张图一次扣费），
 * 重试一次就意味着上游可能白跑一次。
 *
 * 不因此关掉重试——手动重试会再打一次上游、还要再扣用户一次费，自动重试对用户严格更好。
 * 但把放大封顶在 2 倍，不让一张图悄悄烧三次。
 */
export const ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS = 2;
const ARTICLE_RETRY_BASE_MS = 2_000;
const ARTICLE_RETRY_MAX_DELAY_MS = 20_000;

const RETRYABLE_TRANSPORT_CODES = new Set(["econnreset", "econnrefused", "enotfound", "eai_again", "epipe"]);

export function isRetryableArticleWorkflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // 图片侧的失败已经被 image-service 分好类了（含 moderation / 额度型 403），直接信它，
  // 不在这里重算一套判定，免得两处规则漂移。
  const classification = classifyImageGenerationError(error);
  if (classification.category !== "unknown") return classification.retryable;
  const record = error as { name?: unknown; status?: unknown; code?: unknown };
  const status = typeof record.status === "number" ? record.status : null;
  // Anthropic SDK 把 HTTP 状态挂在 error.status 上：429 限流、529 过载、5xx 上游。
  // 409 不进来——那是冲突，重试只会再冲突一次。
  if (status !== null) return status === 408 || status === 429 || status >= 500;
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  return name.includes("timeout")
    || name.includes("connection")
    || code.includes("timeout")
    || RETRYABLE_TRANSPORT_CODES.has(code);
}

export function articleWorkflowRetryDelayMs(attempt: number, env?: NodeJS.ProcessEnv): number {
  const configured = Number(env?.ARTICLE_WORKFLOW_RETRY_BASE_MS);
  const base = Number.isFinite(configured) && configured >= 0
    ? Math.min(ARTICLE_RETRY_MAX_DELAY_MS, configured)
    : ARTICLE_RETRY_BASE_MS;
  return Math.min(ARTICLE_RETRY_MAX_DELAY_MS, base * 2 ** Math.max(0, attempt - 1));
}

export async function withArticleWorkflowRetry<T>(args: {
  readonly work: () => Promise<T>;
  readonly maxAttempts?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** 每次准备重试时回调，用来把「第 N 次重试」写进进度文案 */
  readonly onRetry?: (error: unknown, nextAttempt: number) => Promise<void> | void;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const maxAttempts = Math.max(1, args.maxAttempts ?? ARTICLE_RETRY_MAX_ATTEMPTS);
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await args.work();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableArticleWorkflowError(error)) throw error;
      await args.onRetry?.(error, attempt + 1);
      await sleep(articleWorkflowRetryDelayMs(attempt, args.env));
    }
  }
  throw lastError;
}
