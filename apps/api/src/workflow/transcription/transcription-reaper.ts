/**
 * transcription 卡单回收：把 running 且超期无心跳的任务交回 resumeStaleTasks。
 *
 * 形状对齐 image-reaper.ts：
 * - 不置 failed：runner 可续跑（bailianTaskId 已落库，续跑直接复用百炼任务，
 *   不会重复提交），置 failed 会永久失去续跑机会。只负责「找出来」。
 * - 防双花两道：updatedAt 阈值过滤 + claimStaleTask 的 updatedAt 乐观锁。
 */
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  loadTranscriptionStaleTaskMs,
  TRANSCRIPTION_TASK_STATUS,
  type TranscriptionTaskRow,
} from "./transcription-shared.js";

export const TRANSCRIPTION_REAPER_LOCK_KEY = "ai-assistant:transcription:reaper:lock";
const TRANSCRIPTION_REAPER_INTERVAL_MS = 60_000;
const TRANSCRIPTION_REAPER_BATCH = 200;

export async function scanStaleTranscriptionTasks(args: {
  readonly prisma: PrismaClient;
  readonly resume: (rows: readonly TranscriptionTaskRow[]) => Promise<number>;
  readonly staleMs?: number;
  readonly take?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? loadTranscriptionStaleTaskMs(args.env)));
  const rows = await args.prisma.transcriptionTask.findMany({
    where: { status: TRANSCRIPTION_TASK_STATUS.running, updatedAt: { lt: threshold } },
    orderBy: { createdAt: "asc" },
    take: args.take ?? TRANSCRIPTION_REAPER_BATCH,
  }) as unknown as TranscriptionTaskRow[];
  if (rows.length === 0) return 0;
  try {
    return await args.resume(rows);
  } catch {
    return 0;
  }
}

export function startTranscriptionReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly resume: (rows: readonly TranscriptionTaskRow[]) => Promise<number>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
}): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(TRANSCRIPTION_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
    if (got !== "OK") return;
    try {
      await scanStaleTranscriptionTasks(args);
    } catch (error) {
      args.onError?.(error);
    }
  };
  const timer = setInterval(() => void tick(), TRANSCRIPTION_REAPER_INTERVAL_MS);
  timer.unref();
  return timer;
}
