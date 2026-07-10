import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";

// 收尾：心跳超时（lastSeenAt 早于阈值）的设备，其未关会话用 lastSeenAt 结算，避免时长虚高。
export async function reapStaleSessions(prisma: PrismaClient, staleMs: number): Promise<number> {
  const threshold = new Date(Date.now() - staleMs);
  const stale = await prisma.device.findMany({
    where: { online: true, lastSeenAt: { lt: threshold } },
    select: { id: true, lastSeenAt: true },
  });
  let closed = 0;
  for (const dev of stale) {
    const open = await prisma.deviceSession.findMany({
      where: { deviceId: dev.id, disconnectedAt: null },
    });
    for (const s of open) {
      const end = dev.lastSeenAt ?? new Date();
      const durationSec = Math.max(0, Math.round((end.getTime() - s.connectedAt.getTime()) / 1000));
      await prisma.deviceSession.updateMany({
        where: { id: s.id, disconnectedAt: null },
        data: { disconnectedAt: end, durationSec },
      });
      closed += 1;
    }
    await prisma.device.update({ where: { id: dev.id }, data: { online: false } });
  }
  return closed;
}

// 多实例只跑一个：Redis SET NX 抢锁，60s 周期。
export function startReaper(prisma: PrismaClient, redis: Redis): NodeJS.Timeout {
  const LOCK_KEY = "yunclaude:conn:reaper:lock";
  const tick = async () => {
    const got = await redis.set(LOCK_KEY, "1", "EX", 55, "NX");
    if (got !== "OK") return;
    try {
      await reapStaleSessions(prisma, 300_000);
    } catch {
      // 收尾失败，下个周期自动重试
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref(); // 不阻止进程退出（测试/优雅关闭）
  return timer;
}
