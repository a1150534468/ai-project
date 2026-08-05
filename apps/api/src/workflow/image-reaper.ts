import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  IMAGE_TASK_STATUS,
  IMAGE_TERMINAL_STATUSES,
  IMAGE_UNSETTLED_BILLING_STATUSES,
  type ImageGenerationTaskRow,
  loadImageStaleTaskMs,
} from "./image-shared.js";

export const IMAGE_REAPER_LOCK_KEY = "ai-assistant:image:reaper:lock";
const IMAGE_REAPER_INTERVAL_MS = 60_000;
/** 一轮扫的上限，扫不完留给下一轮，避免重启后一次性拉起太多任务。 */
const IMAGE_REAPER_BATCH = 200;

/**
 * 主动扫：把卡在 running 且超期的任务交回 resumeStaleTasks 继续跑。
 *
 * 在此之前 image 的续跑只挂在 GET /images/tasks 与 /images/state 上，且按 userId 过滤——
 * 用户关掉页面就永远没人推进这一行。这里补的就是「没人轮询」那条路。
 *
 * 和 article 的 reaper 不同，这里**不置 failed**：image 的 runner 可续跑
 * （已出的图落在 imageAsset，重跑只补缺的），置 failed 会把行从 running 里踢出去、
 * 永久失去续跑机会。只负责「找出来」，状态推进仍归 runner。
 *
 * 与被动路径并发不双花靠两道：`updatedAt < 阈值` 让正在跑的行（心跳在刷）压根不进结果集；
 * 真撞上了还有 claimStaleTask 的 updatedAt 乐观锁，只有一个调用方能 claim 成功。
 *
 * resume 收的是**整批**而不是逐行：image 的 resumeStaleTasks 吃 tasks 数组，内部
 * 已经按行 catch 了计费错误，剩下能抛的只有 prisma——那是系统性故障，整轮放弃才对。
 */
export async function scanStaleImageTasks(args: {
  readonly prisma: PrismaClient;
  readonly resume: (rows: readonly ImageGenerationTaskRow[]) => Promise<number>;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? loadImageStaleTaskMs(args.env)));
  const rows = await args.prisma.imageGenerationTask.findMany({
    where: { status: IMAGE_TASK_STATUS.running, updatedAt: { lt: threshold } },
    orderBy: { createdAt: "asc" },
    take: args.take ?? IMAGE_REAPER_BATCH,
  }) as unknown as ImageGenerationTaskRow[];
  if (rows.length === 0) return 0;

  try {
    return await args.resume(rows);
  } catch {
    // 这一轮拉不起来不该拖垮定时器，留给下一轮
    return 0;
  }
}

/**
 * 计费对账：捞终态但预留没落地的行，补一次结算。
 *
 * 扫的是**终态**，不是 running——这一点计划里写反了。漏账的行恰恰是
 * 「状态已经写成 completed/failed/cancelled、结算却没成功」的那些：
 * 续跑不看它（状态已终），收割式 reaper 也不看它（状态已终），钱一直挂在预留里。
 * 拿非终态去扫对账永远是零行，错得静默。
 *
 * 重放安全：operationId 由 requestId 决定，计费侧 Settle 在 status != reserved 时
 * 直接返回、RefundCharge 找不到记录也返回 nil；下游 settleImageTaskBilling 还有
 * billingStatus -> settling 的原子抢占，撞上正常结算路径也只有一个能落地。
 */
export async function reconcileStaleImageBilling(args: {
  readonly prisma: PrismaClient;
  readonly reconcile: (rows: readonly ImageGenerationTaskRow[]) => Promise<number>;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? loadImageStaleTaskMs(args.env)));
  const rows = await args.prisma.imageGenerationTask.findMany({
    where: {
      status: { in: [...IMAGE_TERMINAL_STATUSES] },
      billingMode: "reserve",
      billingStatus: { in: [...IMAGE_UNSETTLED_BILLING_STATUSES] },
      updatedAt: { lt: threshold },
    },
    orderBy: { updatedAt: "asc" },
    take: args.take ?? IMAGE_REAPER_BATCH,
  }) as unknown as ImageGenerationTaskRow[];
  if (rows.length === 0) return 0;

  try {
    return await args.reconcile(rows);
  } catch {
    // 计费还没恢复，留给下一轮
    return 0;
  }
}

/**
 * 两遍都跑：先把还能救的任务拉起来，再把已经终态的漏账补上。
 * 顺序无关（两组行的 status 条件互斥），但先救活的更值钱。
 *
 * 不在启动时立即跑一轮：多实例同时重启会互相抢锁打断，等第一个 interval 更稳。
 */
export function startImageReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly resume: (rows: readonly ImageGenerationTaskRow[]) => Promise<number>;
  readonly reconcile: (rows: readonly ImageGenerationTaskRow[]) => Promise<number>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
}): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(IMAGE_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
    if (got !== "OK") return;
    try {
      await scanStaleImageTasks(args);
      await reconcileStaleImageBilling(args);
    } catch (error) {
      args.onError?.(error);
    }
  };
  const timer = setInterval(() => void tick(), IMAGE_REAPER_INTERVAL_MS);
  timer.unref();
  return timer;
}
