import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import { SCHED, SCHED_KEY } from "./config.js";
import { computeNextRun } from "./schedule.js";

type ExecFn = (taskId: string, slotIso: string) => Promise<void>;

export async function dispatchDueTasks(
  prisma: PrismaClient,
  redis: Redis,
  exec: ExecFn,
  now: Date
): Promise<void> {
  const due = await prisma.scheduledTask.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    take: SCHED.dueBatch,
    orderBy: { nextRunAt: "asc" },
  });

  for (const task of due) {
    const slotIso = task.nextRunAt.toISOString();
    const got = await redis.set(
      SCHED_KEY.slot(task.id, slotIso),
      "1",
      "EX",
      SCHED.slotLockTtlSec,
      "NX"
    );
    if (got !== "OK") continue; // 别的副本在处理该槽位

    const next = computeNextRun(task.cron, task.timezone, now);
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: {
        nextRunAt: next ?? new Date(now.getTime() + 365 * 24 * 3600_000),
        ...(task.oneShot ? { enabled: false } : {}),
      },
    });

    void exec(task.id, slotIso); // 异步派发，不阻塞 tick
  }
}

export function startScheduledDispatcher(
  prisma: PrismaClient,
  redis: Redis,
  exec: ExecFn
): NodeJS.Timeout {
  const tick = async () => {
    try {
      await dispatchDueTasks(prisma, redis, exec, new Date());
    } catch {
      // 单次派发失败，下个 tick 重试
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SCHED.tickMs);
  timer.unref();
  return timer;
}
