import type { PrismaClient } from "@prisma/client";
import { indexOnce, type IndexDeps } from "./indexer.js";

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

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BATCH_SIZE = 20;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function envInteger(name: string, fallback: number): number {
  return positiveInteger(Number(process.env[name]), fallback);
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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
  const intervalMs = positiveInteger(options.intervalMs, envInteger("KB_REAPER_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const leaseMs = positiveInteger(options.leaseMs, envInteger("KB_INDEX_LEASE_MS", DEFAULT_LEASE_MS));
  const maxAttempts = positiveInteger(options.maxAttempts, envInteger("KB_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS));
  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
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
