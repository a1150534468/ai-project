import type { PrismaClient } from "@prisma/client";
import { indexOnce, type IndexDeps } from "./indexer.js";
import { kbBatchSize, kbFailureText, kbLeaseMs, kbMaxAttempts, kbReaperIntervalMs } from "./strategy.js";

export interface ReaperOpts {
  intervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  runIndex?: (docId: string) => Promise<void>;
}

type ReapOptions = {
  leaseMs: number;
  maxAttempts: number;
  batchSize: number;
  runIndex: (docId: string) => Promise<void>;
  shouldStop?: () => boolean;
};

// 默认值与 env 解析全部在 ./strategy.ts —— reaper 与 indexer 共用同一份，
// 否则「改一处不改另一处」会以不报错的方式 desync。
export function failureText(error: unknown): string {
  return kbFailureText(error);
}

/**
 * 一轮先收尸再续跑：最终尝试已经耗尽的过期 indexing 不可能再被 claim，必须显式置 failed，
 * 否则它会永远消失在候选查询之外。普通候选仍 oldest-first、逐篇执行、单篇失败不连坐。
 */
export async function reapOnce(prisma: PrismaClient, options: ReapOptions): Promise<number> {
  const now = new Date();
  const expiredBefore = new Date(now.getTime() - options.leaseMs);
  const exhausted = typeof prisma.document.updateMany === "function"
    ? await prisma.document.findMany({
      where: { status: "indexing", lockedAt: { lt: expiredBefore }, attempts: { gte: options.maxAttempts } },
      orderBy: { createdAt: "asc" },
      take: options.batchSize,
      select: { id: true, lockedBy: true },
    })
    : [];

  let processed = 0;
  for (const doc of exhausted) {
    const closed = await prisma.document.updateMany({
      where: { id: doc.id, status: "indexing", lockedBy: doc.lockedBy, lockedAt: { lt: expiredBefore } },
      data: { status: "failed", error: "Indexing lease expired after final attempt", lockedBy: null, lockedAt: null },
    });
    processed += closed.count;
  }

  const remaining = Math.max(0, options.batchSize - processed);
  if (remaining === 0 || options.shouldStop?.()) return processed;
  const candidates = await prisma.document.findMany({
    where: {
      OR: [{ status: "pending" }, { status: "indexing", lockedAt: { lt: expiredBefore } }],
      attempts: { lt: options.maxAttempts },
    },
    orderBy: { createdAt: "asc" },
    take: remaining,
    select: { id: true },
  });
  for (const doc of candidates) {
    if (options.shouldStop?.()) break;
    try {
      await options.runIndex(doc.id);
      processed += 1;
    } catch (error) {
      console.error(`[reaper] Failed to index document ${doc.id}: ${failureText(error)}`);
    }
  }
  return processed;
}

export function startKbReaper(deps: IndexDeps, options: ReaperOpts = {}): { stop: () => void } {
  const intervalMs = kbReaperIntervalMs(options);
  const leaseMs = kbLeaseMs(options);
  const maxAttempts = kbMaxAttempts(options);
  const batchSize = kbBatchSize(options);
  const runIndex = options.runIndex ?? ((docId) => indexOnce(deps, docId, { maxAttempts, leaseMs }));

  let stopped = false;
  let active: Promise<void> | null = null;
  const cycle = () => {
    if (stopped || active) return;
    active = reapOnce(deps.prisma, {
      leaseMs,
      maxAttempts,
      batchSize,
      runIndex,
      shouldStop: () => stopped,
    }).catch((error) => {
      console.error(`[reaper] Cycle failed: ${failureText(error)}`);
    }).then(() => undefined).finally(() => {
      active = null;
    });
  };
  const timer = setInterval(cycle, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
