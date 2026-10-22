import { envInt, intOr } from "../runtime/env.js";
import { errorMessageOrFallback } from "../workflow/_shared/error-message.js";

/**
 * kb 的租约 / 重试 / 批次策略：**reaper（收尸）与 indexer（续跑）的唯一真值源**。
 *
 * 原先两棵树各存一份默认值、各读一次 env（`KB_INDEX_LEASE_MS` / `KB_MAX_ATTEMPTS`
 * 被读了三遍）。同一目录下的两个模块对「租约多久算卡单」看法不一致是**不报错**的：
 * reaper 认为过期的行，indexer 可能还在自己的窗口里继续续跑，或者反过来——
 * 表现只是偶发的重复索引或永久 failed，查起来极难。所以这两个数必须只有一处定义。
 *
 * options 优先于 env：调用方显式传的值代表这次调用的意图，env 只是没传时的落点。
 */

/** 一个 indexing 行被认领后多久没心跳算「卡单」。 */
export const KB_DEFAULT_LEASE_MS = 300_000;

/** 一篇文档最多尝试几次，超了就置 failed。 */
export const KB_DEFAULT_MAX_ATTEMPTS = 3;

/** reaper 的轮询间隔。 */
export const KB_DEFAULT_REAPER_INTERVAL_MS = 30_000;

/** 一轮最多处理多少行。 */
export const KB_DEFAULT_BATCH_SIZE = 20;

/** 并发 embedding 的上限。 */
export const KB_DEFAULT_EMBED_CONCURRENCY = 4;

export interface KbStrategyOverrides {
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
}

export function kbLeaseMs(
  options: KbStrategyOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intOr(options.leaseMs, envInt(env, "KB_INDEX_LEASE_MS", KB_DEFAULT_LEASE_MS));
}

export function kbMaxAttempts(
  options: KbStrategyOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intOr(options.maxAttempts, envInt(env, "KB_MAX_ATTEMPTS", KB_DEFAULT_MAX_ATTEMPTS));
}

export function kbReaperIntervalMs(
  options: { readonly intervalMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intOr(options.intervalMs, envInt(env, "KB_REAPER_INTERVAL_MS", KB_DEFAULT_REAPER_INTERVAL_MS));
}

export function kbBatchSize(
  options: { readonly batchSize?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intOr(options.batchSize, KB_DEFAULT_BATCH_SIZE);
}

export function kbEmbedConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "KB_EMBED_CONCURRENCY", KB_DEFAULT_EMBED_CONCURRENCY);
}

/** 写进 Document.error 的文案。两个模块此前各自一份、body 逐字节相同。 */
export function kbFailureText(error: unknown): string {
  return errorMessageOrFallback(error, "Unknown error");
}
