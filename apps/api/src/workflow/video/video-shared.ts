/**
 * video 域在 routes 与 reaper 之间共享的常量与行类型。
 *
 * 存在的唯一理由是破循环导入：`video-reaper.ts` 需要这些东西，
 * 而 `video-routes.ts` 要 import reaper 去起定时器。放这里之后
 * reaper 对 routes 是零 import（不是靠 `import type` 擦除绕过）。
 * 与 portrait-shared.ts / image-shared.ts 同构。
 */

export const VIDEO_TASK_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
} as const;

/**
 * 两次 `updatedAt` 写入之间的最长间隔（不是任务总耗时）。
 *
 * 阈值必须盖住**心跳间隔**：只要还有 runner 在推进这一行，它就会周期性刷
 * `@updatedAt`；超过这个间隔没动静，才说明推进它的进程已经不在了。
 * video 的心跳有两段空窗，取较大者：
 *
 * 1. 建行 → 提交成功那一刻。中间是 `submitWithRetry`，最坏
 *    `VIDEO_SUBMIT_TIMEOUT_MS`(60s) × (1 + `VIDEO_SUBMIT_RETRIES`(2))
 *    + 2 × `VIDEO_SUBMIT_RETRY_DELAY_MS`(2s) = 184s。
 * 2. 最后一次轮询 → 标记 completed。中间夹着视频下载（`fetchRemoteVideo`
 *    里硬编码 120s 超时）+ S3 上传 + `videoAsset` upsert。取 120s + 余量。
 *
 * 轮询过程本身**不是**空窗：`pollVideoUntilDone` 每轮都 `update` 一次，
 * 间隔只有 `VIDEO_POLL_INTERVAL_MS`(10s)。所以阈值与
 * `maxPollAttempts × pollIntervalMs`（默认 600s 的总窗口）无关 ——
 * 拿总窗口当阈值会让兜底晚十分钟才介入。
 *
 * 取 184s 的两倍再取整到 10 分钟：既盖得住上面两段，也给上游偶发慢留了余量。
 * 误判的代价不对称（把在跑的行判成卡单 → 可能错误退款），所以宁可保守。
 */
export const DEFAULT_VIDEO_STALE_TASK_MS = 10 * 60_000;

export function loadVideoStaleTaskMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.VIDEO_STALE_TASK_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VIDEO_STALE_TASK_MS;
}

/**
 * `videoGenerationTask` 的行形状。
 *
 * 注意：这是结构上的子集，reaper 的 `findMany` **不能加 `select`** ——
 * 少了列在编译期看不出来，运行期才会以 undefined 的形式炸在计费或续跑里。
 * 与 `video-routes.ts` 里的 `VideoTaskRow` 保持一致（那边是同一形状的私有副本，
 * 用于路由序列化；两处若要改字段，一起改）。
 */
export interface VideoTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly providerTaskId: string | null;
  readonly prompt: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly durationSec: number;
  readonly generateAudio: boolean;
  readonly hasInputVideo: boolean;
  readonly resourceKey: string;
  readonly chargedPoints: number;
  readonly status: string;
  readonly progress: number;
  readonly error: string | null;
  readonly resultPayload: unknown;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `operationId` 由 `requestId` 派生，`requestId` 是 `@unique` 列，所以兜底扫可以原地重建、不需要新列。 */
export function videoOperationId(requestId: string): string {
  return `video:${requestId}`;
}
