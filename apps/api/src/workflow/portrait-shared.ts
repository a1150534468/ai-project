import { loadImageAttemptTimeoutMs } from "./image-service.js";

/** 单次上游失败后的重试间隔（固定间隔，不退避）。 */
export const PORTRAIT_RETRY_DELAY_MS = 3_000;
/** 单张图的系统兜底重试次数。 */
export const PORTRAIT_DEFAULT_MAX_ATTEMPTS = 3;
/** 写完这些状态之后不会再有 runner 推进，扫描与收割都要跳过。 */
export const PORTRAIT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "failed", "cancelled"]);
/** 还可能被 runner 推进的状态。主动扫和被动 recover 用的是同一组。 */
export const PORTRAIT_ACTIVE_STATUSES = ["pending", "running"] as const;
/**
 * 卡死判定的兜底下限，仅在推导值更小时生效。
 * 真实阈值走 {@link portraitTaskStaleMs}——按当前出图超时与重试预算推导。
 */
export const PORTRAIT_TASK_STALE_MS = 15 * 60_000;

export function portraitRetryDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORTRAIT_RETRY_DELAY_MS) || PORTRAIT_RETRY_DELAY_MS;
}

export function portraitMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORTRAIT_MAX_ATTEMPTS) || PORTRAIT_DEFAULT_MAX_ATTEMPTS;
}

/**
 * 心跳是 `updatedAt`：runner 每出完一张图就写一次 completedCount，@updatedAt 自动刷新。
 * 所以阈值要盖住的不是整个任务的耗时（count 最多 4 张，那是 4 倍），
 * 而是**两次心跳之间的最长间隔**——即产出单张图的最坏耗时。
 *
 * 单张上限 = 单次尝试超时 × 兜底重试次数 + 固定间隔退避。
 * 照 article 的教训（那边写死 15 分钟，加了重试后把在跑的行误判成超时收尸），
 * 这里从同一批常量推导，超时或重试预算调整时不会悄悄失配。
 */
export function portraitTaskStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const attemptMs = loadImageAttemptTimeoutMs(env);
  const attempts = portraitMaxAttempts(env);
  const backoffMs = Math.max(0, attempts - 1) * portraitRetryDelayMs(env);
  // 1.5 倍余量留给下载、sharp 解析、S3 上传等非上游耗时。
  const worstImageMs = Math.round((attemptMs * attempts + backoffMs) * 1.5);
  return Math.max(PORTRAIT_TASK_STALE_MS, worstImageMs);
}
