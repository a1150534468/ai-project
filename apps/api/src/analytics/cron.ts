import type { PrismaClient } from "@yc/db";
import type { Redis } from "ioredis";
import { createBillingClient } from "@yc/billing";
import { runRollup, defaultWindow } from "./rollup.js";

// 每小时 tick；本地 02 点 + 当日去重锁 触发一次 rollup（最近 31 天窗口）。
export function startAnalyticsRollup(prisma: PrismaClient, redis: Redis): NodeJS.Timeout {
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const tick = async () => {
    const now = new Date();
    if (now.getHours() !== 2) return;
    const today = now.toISOString().slice(0, 10);
    const got = await redis.set(`yunclaude:analytics:rollup:lock:${today}`, "1", "EX", 7200, "NX");
    if (got !== "OK") return;
    try {
      await runRollup(prisma, billing, defaultWindow(today));
    } catch {
      // 本次失败，次日或 rebuild 补；不污染已有快照（runRollup 内事务化）
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 3_600_000);
  timer.unref();
  return timer;
}
