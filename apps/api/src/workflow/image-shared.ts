/**
 * image 域里 routes 与 reaper 都要用的常量。
 *
 * 单独一个文件的唯一原因是破循环导入：image-routes 要 import reaper 来起定时器，
 * reaper 又要用 routes 里的状态常量与阈值。让两边都只依赖本文件，本文件谁也不依赖。
 * 形状对齐 portrait-shared.ts / article-workflow-shared.ts。
 */

const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;

export const IMAGE_TASK_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * 终态。写完这些之后不会再有 runner 推进这一行；`running` 是唯一的非终态。
 *
 * 注意对账扫的是**这一组**，不是 running：漏账的行恰恰是
 * 「状态已经写成终态、但结算没落地」的，拿非终态去扫对账永远是零行
 * （这一点计划里写错了，见 P0.4 执行记录）。
 */
export const IMAGE_TERMINAL_STATUSES = [
  IMAGE_TASK_STATUS.completed,
  IMAGE_TASK_STATUS.failed,
  IMAGE_TASK_STATUS.cancelled,
] as const;

/** 还没结算掉的预留状态。settling 由 reconcile 自己再判一次是否真卡住。 */
export const IMAGE_UNSETTLED_BILLING_STATUSES = ["reserved", "settle_failed", "settling"] as const;

/** 进程崩在 settling 的预留：超过该时长视为无人认领，可重置回 reserved 再结算。 */
export const SETTLING_STALE_MS = 10 * 60_000;

/**
 * 卡单判定阈值。
 *
 * 盖的是**两次心跳之间的最长间隔**，不是整个任务的耗时——runner 每次重试都会
 * 在 onRetry 里 updateTask（刷 @updatedAt），所以最长间隔就是「一次尝试超时 + 一次退避」，
 * **不乘 maxAttempts**。这与 portrait 不同：portrait 的心跳是每出完一张图刷一次，
 * 那里要盖单张图的最坏耗时（含全部重试预算），所以那边的阈值大得多。
 * 抄阈值前先看清这个域的心跳是什么时候刷的。
 *
 * 已知不一致（本次原样搬移、未改）：这里用的是**默认**尝试超时常量，不读
 * IMAGE_ATTEMPT_TIMEOUT_MS。把那个 env 调大而不同步调大 IMAGE_STALE_TASK_MS，
 * 阈值就会短于单次尝试，在跑的行会被判成卡单。修它属于行为变更，另开任务。
 */
export const DEFAULT_STALE_TASK_MS = DEFAULT_ATTEMPT_TIMEOUT_MS + DEFAULT_RETRY_DELAY_MS + 30_000;

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
 * （runImageGenerationTask 要 referenceAssetIds / count / billingResourceKey）。
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
  // 旧任务（升级前创建）没有这些列的值：billingMode 缺省视为 "charge"。
  readonly billingMode?: string;
  readonly billingResourceKey?: string | null;
  readonly billingReservedUnits?: number;
  readonly billingSettledUnits?: number | null;
  readonly billingStatus?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
