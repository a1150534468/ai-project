import type { PrismaClient } from "@ai-assistant/db";
import type { Redis } from "ioredis";
import type { SkyhumanConfig, FetchLike } from "./dub-skyhuman-client.js";
import { finalizeSkyhumanTask, type FinalizeBilling, type StoredVideo } from "./dub-finalize.js";
import { DUB_TASK_STATUS, DUB_REAPER_LOCK_KEY, DUB_TASK_STALE_MS } from "./dub-constants.js";

type StoreVideoFn = (a: { url: string; userId: string; taskId: string }) => Promise<StoredVideo>;
type FinalizeProjectFn = (a: { projectId: string; videoUrl: string; videoObjectKey: string }) => Promise<void>;
type FinalizeFn = (a: { prisma: PrismaClient; billing: FinalizeBilling; cfg: SkyhumanConfig; fetchFn: FetchLike; taskId: string; storeVideo: StoreVideoFn; finalizeProject?: FinalizeProjectFn }) => Promise<void>;

export interface ReaperArgs {
  prisma: PrismaClient; cfg: SkyhumanConfig; fetchFn: FetchLike; billing: FinalizeBilling;
  storeVideo: StoreVideoFn;
  staleMs: number;
  finalize?: FinalizeFn;
  // 兜底路径同样要触发项目 BGM 收尾，否则回调丢失时项目会永远停在 generating
  finalizeProject?: FinalizeProjectFn;
}

export async function reapStaleSkyhumanTasks(args: ReaperArgs): Promise<number> {
  const finalize = args.finalize ?? finalizeSkyhumanTask;
  const threshold = new Date(Date.now() - args.staleMs);
  const stale = await args.prisma.skyhumanTask.findMany({
    where: { status: DUB_TASK_STATUS.running, updatedAt: { lt: threshold } },
    select: { id: true, operationId: true, providerTaskId: true },
  });
  for (const t of stale) {
    if (t.providerTaskId) {
      // 已提交上游：轮询补查终态（回调漏掉/后台进程重启的兜底）
      await finalize({ prisma: args.prisma, billing: args.billing, cfg: args.cfg, fetchFn: args.fetchFn, taskId: t.id, storeVideo: args.storeVideo, finalizeProject: args.finalizeProject }).catch(() => undefined);
    } else {
      // 从未提交（后台崩溃或并发触顶未占到位）：已扣款却无法恢复（上传 buffer 未持久化）→ 退款并置失败，避免扣款卡死
      await args.billing.refundResource(t.operationId).catch(() => undefined);
      await args.prisma.skyhumanTask.updateMany({
        where: { id: t.id, status: DUB_TASK_STATUS.running },
        data: { status: DUB_TASK_STATUS.failed, error: "提交失败或平台繁忙，已退款" },
      }).catch(() => undefined);
    }
  }
  return stale.length;
}

export function startDubReaper(args: Omit<ReaperArgs, "staleMs"> & { redis: Redis }): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(DUB_REAPER_LOCK_KEY, "1", "EX", 55, "NX");
    if (got !== "OK") return;
    try { await reapStaleSkyhumanTasks({ ...args, staleMs: DUB_TASK_STALE_MS }); } catch { /* 下轮重试 */ }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return timer;
}
