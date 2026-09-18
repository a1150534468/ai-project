import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  PORTRAIT_ACTIVE_STATUSES,
  PORTRAIT_TERMINAL_STATUSES,
  portraitTaskStaleMs,
} from "./portrait-shared.js";

export const PORTRAIT_REAPER_LOCK_KEY = "ai-assistant:portrait:reaper:lock";
const PORTRAIT_REAPER_INTERVAL_MS = 60_000;
/** 一轮扫的上限，扫不完留给下一轮，避免重启后一次性拉起太多任务。 */
const PORTRAIT_REAPER_BATCH = 200;

/**
 * reaper 自己只读这几列，但行是**整行原样**透传给 resume/settle 的
 * ——那两个回调要用 billingResourceKey / count / referenceAssetIds。
 * 所以下面两个 findMany 一律不加 `select`：加了会让透传的行缺列，
 * 且缺的是编译期看不出来的（这里声明的是结构子集）。
 */
export interface PortraitStaleRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly status: string;
  readonly completedCount: number;
  readonly billingStatus: string;
  readonly billingOperationId: string;
}

/**
 * 主动扫：把卡在 pending|running 且超期的任务交回 resume 继续跑。
 *
 * 与 article 的 reaper 不同，这里**不置 failed**。portrait 的 runner 是可续跑的
 * （已出的图落在 PortraitOutput，重跑只补缺的 requestIndex），置 failed 反而会把行
 * 从 pending|running 里踢出去、永久失去续跑机会。所以这里只负责「找出来」，
 * 真正的续跑与状态推进仍归 runner。
 *
 * 靠 `updatedAt < 阈值` 天然避开正在别的实例上跑的行：那些行心跳还在刷新。
 */
export async function scanStalePortraitTasks(args: {
  readonly prisma: PrismaClient;
  readonly resume: (row: PortraitStaleRow) => Promise<void> | void;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? portraitTaskStaleMs(args.env)));
  const rows = await args.prisma.portraitTask.findMany({
    where: { status: { in: [...PORTRAIT_ACTIVE_STATUSES] }, updatedAt: { lt: threshold } },
    orderBy: { createdAt: "asc" },
    take: args.take ?? PORTRAIT_REAPER_BATCH,
  }) as unknown as PortraitStaleRow[];

  let resumed = 0;
  for (const row of rows) {
    try {
      await args.resume(row);
      resumed += 1;
    } catch {
      // 单行拉不起来不该拖垮整轮，留给下一轮
    }
  }
  return resumed;
}

/**
 * 计费对账：捞终态但 billingStatus 仍是 reserved 的行，补一次结算。
 *
 * 这类行来自 runPortraitTask 的失败分支——那里 `settlePortraitBilling(...).catch(() => undefined)`
 * 之后照写终态。计费服务当时不可用的话，异常被吞掉，行就带着 reserved 进了终态：
 * recover() 不看它（状态已终），收割式 reaper 也不看它（状态已终），钱就一直挂在预留里。
 *
 * 结算金额按 completedCount：出了几张收几张的钱，0 张走退款。
 * 重复调用是安全的——计费侧 Settle 在 status != reserved 时直接返回，
 * RefundCharge 找不到记录也返回 nil，都按 operationId 幂等。
 */
export async function reconcileStalePortraitBilling(args: {
  readonly prisma: PrismaClient;
  readonly settle: (input: { task: PortraitStaleRow; units: number }) => Promise<void>;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? portraitTaskStaleMs(args.env)));
  const rows = await args.prisma.portraitTask.findMany({
    where: {
      status: { in: [...PORTRAIT_TERMINAL_STATUSES] },
      billingStatus: "reserved",
      updatedAt: { lt: threshold },
    },
    orderBy: { updatedAt: "asc" },
    take: args.take ?? PORTRAIT_REAPER_BATCH,
  }) as unknown as PortraitStaleRow[];

  let fixed = 0;
  for (const row of rows) {
    try {
      await args.settle({ task: row, units: row.completedCount });
      fixed += 1;
    } catch {
      // 计费还没恢复，留给下一轮
    }
  }
  return fixed;
}

/**
 * 两遍都跑：先把还能救的任务拉起来，再把已经终态的漏账补上。
 * 顺序无关（两组行的 status 条件互斥），但先救活的更值钱。
 */
export function startPortraitReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly resume: (row: PortraitStaleRow) => Promise<void> | void;
  readonly settle: (input: { task: PortraitStaleRow; units: number }) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
}): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(PORTRAIT_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
    if (got !== "OK") return;
    try {
      await scanStalePortraitTasks(args);
      await reconcileStalePortraitBilling(args);
    } catch (error) {
      args.onError?.(error);
    }
  };
  const timer = setInterval(() => void tick(), PORTRAIT_REAPER_INTERVAL_MS);
  timer.unref();
  return timer;
}
