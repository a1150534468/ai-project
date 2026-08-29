/**
 * video-routes 拆分后的旋钮与叶子工具层:超时/轮询/重试/保留条数的默认值,以及
 * `loadNumber` / `safeErrorMessage` / `wait` 三个无状态小工具。
 *
 * 这里的常量全是"默认值",真正生效的值由路由层 `loadNumber(envKey, 默认值)` 读环境变量
 * 覆盖。默认值和 env key 必须在同一处可见,否则改了默认值却漏改 env 名会得到一个
 * 永远读不到的旋钮 —— 所以别把这些常量挪进各自的使用方文件。
 *
 * `videoTaskStatus` 是 `VIDEO_TASK_STATUS` 的别名。它当初是为了"搬去 video-shared.ts
 * 破循环导入,又不想把整个文件的引用点全改一遍"而留的,拆分后同样保留:去掉它等于要
 * 动 task / plugin 两个文件里十几处调用,那就不是纯移动了。
 *
 * 依赖方向:本文件是叶子(只依赖 error-message 与 video-shared)。不 import 同域任何文件。
 */

import { errorMessageOrFallback } from "../_shared/error-message.js";
import { VIDEO_TASK_STATUS } from "./video-shared.js";

export const VIDEO_KEEP_LIMIT = 30;
export const VIDEO_TASK_KEEP_LIMIT = 20;
export const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;
export const DEFAULT_STATUS_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INITIAL_DELAY_MS = 5_000;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_POLL_ATTEMPTS = 60;

/** 从 video-shared.ts 搬来（reaper 也要用，放共享文件破循环导入）。别名保留，免得这一整个文件都要改。 */
export const videoTaskStatus = VIDEO_TASK_STATUS;

// 参考视频独立小限（区别于生成素材的 350MB）；UI 引导 30 秒以内。
export const VIDEO_REF_MAX_BYTES = Number(process.env.VIDEO_REF_MAX_BYTES) || 50 * 1024 * 1024;

export const DEFAULT_SUBMIT_RETRIES = 2;
export const DEFAULT_SUBMIT_RETRY_DELAY_MS = 2_000;

export function loadNumber(envKey: string, fallback: number): number {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "视频生成失败");
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
