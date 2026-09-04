/**
 * image 域里 routes 与 reaper 都要用的常量。
 *
 * 单独一个文件的唯一原因是破循环导入：image-routes 要 import reaper 来起定时器，
 * reaper 又要用 routes 里的状态常量与阈值。让两边都只依赖本文件；本文件只许依赖
 * 「自己谁也不 import」的叶子模块（image-dispatch-gate.ts 就是这样的），
 * 这样循环从根上不成立。形状对齐 portrait-shared.ts / article-workflow-shared.ts。
 */

import { DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS } from "../_shared/image-dispatch-gate.js";

const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;

export const IMAGE_TASK_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * 卡单判定阈值。
 *
 * 盖的是**两次心跳之间的最长间隔**，不是整个任务的耗时——runner 每次重试都会
 * 在 onRetry 里 updateTask（刷 @updatedAt），所以最长间隔就是
 * 「闸门最坏排队 + 一次尝试超时 + 一次退避」（排队等许可的那段不写心跳），
 * **不乘 maxAttempts**。这与 portrait 不同：portrait 的心跳是每出完一张图刷一次，
 * 那里要盖单张图的最坏耗时（含全部重试预算），所以那边的阈值大得多。
 * 抄阈值前先看清这个域的心跳是什么时候刷的。
 *
 * 已知不一致（本次原样保留、未改）：这里用的是**默认**尝试超时常量，不读
 * IMAGE_ATTEMPT_TIMEOUT_MS。把那个 env 调大而不同步调大 IMAGE_STALE_TASK_MS，
 * 阈值就会短于单次尝试，在跑的行会被判成卡单。修它属于行为变更，另开任务。
 * 同理这里加的是闸门的**默认**排队上限，改 IMAGE_UPSTREAM_QUEUE_WAIT_MS 也要同步。
 */
export const DEFAULT_STALE_TASK_MS =
  DEFAULT_ATTEMPT_TIMEOUT_MS + DEFAULT_IMAGE_UPSTREAM_QUEUE_WAIT_MS + DEFAULT_RETRY_DELAY_MS + 30_000;

export function loadImageStaleTaskMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_STALE_TASK_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_TASK_MS;
}

/**
 * 任务行。放在这里是为了让 image-reaper **完全不 import image-routes**——
 * 它只需要把整行透传回去，类型跟着行走就够，循环导入从根上不存在。
 *
 * reaper 的 findMany 一律不加 `select`：这个接口是数据库行的结构子集，
 * 加了 select 会让透传的行缺列，而缺的列编译期看不出来
 * （runImageGenerationTask 要 referenceAssetIds / count）。
 */
export interface ImageGenerationTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly referenceAssetIds?: readonly string[];
  readonly sourceImageAssetId?: string | null;
  readonly generationIntent?: string;
  readonly count: number;
  readonly status: string;
  readonly completedCount: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
