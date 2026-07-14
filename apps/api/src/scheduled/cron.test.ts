import { describe, it, expect, vi } from "vitest";
import { dispatchDueTasks } from "./cron.js";

function setup(tasks: any[]) {
  const updated: any[] = [];
  const prisma = {
    scheduledTask: {
      findMany: vi.fn().mockResolvedValue(tasks),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        updated.push({ id: where.id, data });
        return Promise.resolve({});
      }),
    },
  };
  const redis = { set: vi.fn().mockResolvedValue("OK") };
  const exec = vi.fn().mockResolvedValue(undefined);
  return { prisma, redis, exec, updated };
}

const now = new Date("2026-07-09T00:00:00Z");

describe("dispatchDueTasks", () => {
  it("到期任务：抢槽位锁→推进 nextRunAt→派发 exec", async () => {
    const s = setup([
      {
        id: "t1",
        cron: "0 8 * * *",
        timezone: "Asia/Shanghai",
        oneShot: false,
        nextRunAt: now,
      },
    ]);
    await dispatchDueTasks(s.prisma as any, s.redis as any, s.exec, now);
    expect(s.redis.set).toHaveBeenCalledWith(
      expect.stringContaining("ai-assistant:sched:run:t1:"),
      "1",
      "EX",
      expect.any(Number),
      "NX"
    );
    expect(s.updated[0].data.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(s.exec).toHaveBeenCalledWith("t1", expect.any(String));
  });

  it("槽位锁被别的副本占用 → 不推进、不派发", async () => {
    const s = setup([
      {
        id: "t1",
        cron: "0 8 * * *",
        timezone: "UTC",
        oneShot: false,
        nextRunAt: now,
      },
    ]);
    s.redis.set.mockResolvedValue(null);
    await dispatchDueTasks(s.prisma as any, s.redis as any, s.exec, now);
    expect(s.updated.length).toBe(0);
    expect(s.exec).not.toHaveBeenCalled();
  });

  it("oneShot：推进的同时 enabled=false", async () => {
    const s = setup([
      {
        id: "t1",
        cron: "0 8 * * *",
        timezone: "UTC",
        oneShot: true,
        nextRunAt: now,
      },
    ]);
    await dispatchDueTasks(s.prisma as any, s.redis as any, s.exec, now);
    expect(s.updated[0].data.enabled).toBe(false);
    expect(s.exec).toHaveBeenCalledWith("t1", expect.any(String));
  });
});
