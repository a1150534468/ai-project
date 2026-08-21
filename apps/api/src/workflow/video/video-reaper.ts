import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { loadVideoStaleTaskMs, VIDEO_TASK_STATUS, type VideoTaskRow } from "./video-shared.js";

/**
 * video 的超时兜底。
 *
 * 与其他域最大的不同：video 是**外部异步任务** —— 先把活提交给上游拿
 * `providerTaskId`，再轮询结果。所以「卡住」有两种，处置完全相反：
 *
 * - 本地进程没了（部署重启、pod 被杀），上游还在正常跑 → 应当**恢复轮询**，
 *   绝不能置 failed 退款。那会把用户已经生成好的视频丢掉、钱也退了，
 *   而上游还在继续算 —— 三头亏。
 * - 上游确实没有这个任务了 → 才是置 failed + 退款。
 *
 * 判断这两者的唯一办法是拿 `providerTaskId` 去上游问一次真实状态。所以本文件
 * 不做任何「超期即置 failed」，`article-workflow-reaper` 那套形状在这里是有害的。
 *
 * 探测结果为 `unknown`（5xx / 超时 / 网络 / 响应体坏）时**一行都不动**，等下一轮。
 * 宁可多等 60 秒，不可错退一笔。
 */

const VIDEO_REAPER_LOCK_KEY = "ai-assistant:video:reaper:lock";
const VIDEO_REAPER_INTERVAL_MS = 60_000;
/** 单轮上限。每行都要向上游发一次请求，批量别开太大，免得一轮打爆上游限流。 */
const VIDEO_REAPER_BATCH = 50;

export { VIDEO_REAPER_LOCK_KEY };

/** 一行的处置结果，只用于日志与测试断言。 */
export type VideoReapOutcome =
  | "resumed"      // 上游仍在跑 / 已完成 → 交回续跑（不退款）
  | "failed"       // 上游查不到，或压根没提交成功 → 置 failed + 退款
  | "left-alone"   // 上游暂时答不了 → 原样不动，等下一轮
  | "error";       // 处置本身抛了，这一行留给下一轮

export interface VideoReapHandlers {
  /**
   * 上游仍认这个任务（在跑或已完成）→ 接着把它跑完。
   * 实现在插件里：复用「提交之后那半段」（轮询 → 入库 → 结算 → 标记完成）。
   */
  readonly resume: (row: VideoTaskRow) => Promise<void>;
  /** 判定这一行没救了 → 退款 + 置 failed。 */
  readonly fail: (row: VideoTaskRow, reason: string) => Promise<void>;
  /**
   * 向上游问一次这一行的真实状态。三态，见 `probeVideoGenerationStatus`。
   * 由插件注入，便于测试与共用 `fetchFn`/配置。
   */
  readonly probe: (row: VideoTaskRow & { readonly providerTaskId: string }) => Promise<
    { readonly kind: "found"; readonly upstreamFailed: boolean }
    | { readonly kind: "missing" }
    | { readonly kind: "unknown"; readonly reason: string }
  >;
  readonly onOutcome?: (row: VideoTaskRow, outcome: VideoReapOutcome, detail?: string) => void;
}

/**
 * 扫出心跳超期的 running 行，逐行按上游真实状态处置。
 *
 * **逐行 try/catch**（与 image 的整批交回不同）：这里每行都要独立发一次上游请求，
 * 一行的网络失败不该带走整批 —— 尤其是紧接着的那一行可能正好是能救回来的。
 */
export async function reapStaleVideoTasks(args: {
  readonly prisma: PrismaClient;
  readonly handlers: VideoReapHandlers;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<{ readonly scanned: number; readonly resumed: number; readonly failed: number; readonly leftAlone: number }> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? loadVideoStaleTaskMs(args.env)));
  const rows = await args.prisma.videoGenerationTask.findMany({
    where: { status: VIDEO_TASK_STATUS.running, updatedAt: { lt: threshold } },
    orderBy: { createdAt: "asc" },
    take: args.take ?? VIDEO_REAPER_BATCH,
  }) as unknown as VideoTaskRow[];

  let resumed = 0;
  let failed = 0;
  let leftAlone = 0;
  for (const row of rows) {
    const outcome = await reapOneVideoTask(row, args.handlers);
    if (outcome === "resumed") resumed += 1;
    else if (outcome === "failed") failed += 1;
    else leftAlone += 1;
  }
  return { scanned: rows.length, resumed, failed, leftAlone };
}

async function reapOneVideoTask(row: VideoTaskRow, handlers: VideoReapHandlers): Promise<VideoReapOutcome> {
  try {
    // 没有 providerTaskId：提交前（或提交中）就崩了，上游根本不知道这活。
    // 没有任何东西可续，直接退款收尸 —— 这是本域唯一可以不问上游就判失败的情形。
    if (!row.providerTaskId) {
      await handlers.fail(row, "提交前中断：无 providerTaskId");
      handlers.onOutcome?.(row, "failed", "no provider task id");
      return "failed";
    }

    const probed = await handlers.probe(row as VideoTaskRow & { readonly providerTaskId: string });
    if (probed.kind === "unknown") {
      // 上游暂时答不了。原样不动：既不退款也不改状态，下一轮再问。
      handlers.onOutcome?.(row, "left-alone", probed.reason);
      return "left-alone";
    }
    if (probed.kind === "missing") {
      await handlers.fail(row, "上游已无此任务");
      handlers.onOutcome?.(row, "failed", "provider task missing");
      return "failed";
    }
    if (probed.upstreamFailed) {
      // 上游明确说这活失败了。退款收尸。
      await handlers.fail(row, "上游任务失败");
      handlers.onOutcome?.(row, "failed", "provider task failed");
      return "failed";
    }
    // 上游仍在跑，或已完成但本地还没入库 —— 两种都是「接着跑完」，
    // 交给同一个 resume：它内部就是轮询到终态再入库结算，已完成的那轮会立刻返回。
    await handlers.resume(row);
    handlers.onOutcome?.(row, "resumed");
    return "resumed";
  } catch (error) {
    // 处置这一行时抛了（上游探测之外的意外）。不改状态、不退款，留给下一轮。
    handlers.onOutcome?.(row, "error", error instanceof Error ? error.message.slice(0, 200) : "reap failed");
    return "error";
  }
}

/**
 * 起定时器。形状与本仓既有的 6 个 `start*Reaper` 一致：
 * Redis `SET NX EX 55` 抢锁（多实例同时只有一个干活）+ `setInterval` 60s + `unref`，
 * **刻意不立即跑第一轮** —— 同时重启的多个实例会在启动瞬间抢同一把锁。
 */
export function startVideoReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly handlers: VideoReapHandlers;
  readonly onError?: (error: unknown) => void;
}): NodeJS.Timeout {
  const tick = async () => {
    try {
      const got = await args.redis.set(VIDEO_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
      if (got !== "OK") return;
      await reapStaleVideoTasks({ prisma: args.prisma, handlers: args.handlers });
    } catch (error) {
      args.onError?.(error);
    }
  };
  const timer = setInterval(() => void tick(), VIDEO_REAPER_INTERVAL_MS);
  timer.unref();
  return timer;
}
