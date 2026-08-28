import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  PORTRAIT_REAPER_LOCK_KEY,
  reconcileStalePortraitBilling,
  scanStalePortraitTasks,
  startPortraitReaper,
} from "./portrait-reaper.js";
import { PORTRAIT_TASK_STALE_MS, portraitTaskStaleMs } from "./portrait-shared.js";
import { portraitWorkflowRoutes } from "./portrait-routes.js";

type TaskRow = {
  id: string;
  userId: string;
  requestId: string;
  status: string;
  completedCount: number;
  billingStatus: string;
  billingOperationId: string;
};

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    userId: "u1",
    requestId: "req-1",
    status: "running",
    completedCount: 0,
    billingStatus: "reserved",
    billingOperationId: "portrait:t1",
    ...over,
  };
}

function fakePrisma(rows: TaskRow[]) {
  const portraitTask = {
    findMany: vi.fn(async (_args: { where: unknown; take?: number }) => rows),
  };
  return { prisma: { portraitTask } as never, portraitTask };
}

describe("scanStalePortraitTasks", () => {
  it("跨用户捞超期的 pending/running 交给 resume，不自己写状态", async () => {
    const rows = [task({ id: "t1", userId: "u1" }), task({ id: "t2", userId: "u2", status: "pending" })];
    const { prisma, portraitTask } = fakePrisma(rows);
    const resume = vi.fn(async (_row: unknown) => undefined);

    const scanned = await scanStalePortraitTasks({ prisma, resume, staleMs: 1_000, now: () => 100_000 });

    expect(scanned).toBe(2);
    const where = portraitTask.findMany.mock.calls[0]![0].where as {
      status: { in: string[] };
      updatedAt: { lt: Date };
      userId?: unknown;
    };
    expect(where.status.in).toEqual(["pending", "running"]);
    expect(where.updatedAt.lt).toEqual(new Date(99_000));
    // 主动扫是全局的：不能带 userId，否则又退化成只救当前登录用户。
    expect(where.userId).toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls.map(([row]) => (row as TaskRow).id)).toEqual(["t1", "t2"]);
  });

  it("单行 resume 抛错不影响后面的行", async () => {
    const { prisma } = fakePrisma([task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })]);
    const resume = vi.fn(async (row: unknown) => {
      if ((row as TaskRow).id === "t1") throw new Error("schedule blew up");
    });

    const scanned = await scanStalePortraitTasks({ prisma, resume, staleMs: 1_000, now: () => 100_000 });

    expect(scanned).toBe(2);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it("批量有上限，一轮扫不完留给下一轮", async () => {
    const { prisma, portraitTask } = fakePrisma([]);
    const resume = vi.fn(async () => undefined);

    await scanStalePortraitTasks({ prisma, resume, staleMs: 1_000, now: () => 100_000, take: 200 });

    expect(portraitTask.findMany.mock.calls[0]![0].take).toBe(200);
  });

  it("默认阈值盖住单张图的最坏耗时，不误杀在跑的任务", async () => {
    // 回归：article 那边阈值写死 15 分钟，加了重试后把在跑的行判成超时收尸。
    // portrait 的心跳是「每出完一张写一次 completedCount」，所以阈值要盖住单张的最坏耗时。
    const env = { IMAGE_ATTEMPT_TIMEOUT_MS: "600000", PORTRAIT_MAX_ATTEMPTS: "3", PORTRAIT_RETRY_DELAY_MS: "3000" };
    expect(portraitTaskStaleMs(env)).toBeGreaterThan(3 * 600_000);

    const { prisma, portraitTask } = fakePrisma([]);
    await scanStalePortraitTasks({ prisma, resume: vi.fn(async () => undefined), env, now: () => 10_000_000 });
    const where = portraitTask.findMany.mock.calls[0]![0].where as { updatedAt: { lt: Date } };
    expect(where.updatedAt.lt).toEqual(new Date(10_000_000 - portraitTaskStaleMs(env)));
  });

  it("出图超时调小时阈值跟着收紧，但不低于兜底下限", () => {
    const tight = portraitTaskStaleMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "60000" });
    const loose = portraitTaskStaleMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "600000" });
    expect(tight).toBeLessThan(loose);
    expect(tight).toBe(PORTRAIT_TASK_STALE_MS);
  });

  it("阈值把共享派发闸门的排队等待算进去：排队期间不刷 completedCount", () => {
    const base = { IMAGE_ATTEMPT_TIMEOUT_MS: "600000", PORTRAIT_MAX_ATTEMPTS: "3", PORTRAIT_RETRY_DELAY_MS: "3000" };
    const queued = portraitTaskStaleMs({ ...base, IMAGE_UPSTREAM_QUEUE_WAIT_MS: "300000" });
    const noGate = portraitTaskStaleMs({ ...base, IMAGE_UPSTREAM_CONCURRENCY: "0" });
    // 单张图的每次尝试都可能先排队，所以差值是 排队上限 × 尝试次数 × 1.5 余量。
    expect(queued - noGate).toBe(3 * 300_000 * 1.5);
    expect(noGate).toBeLessThan(portraitTaskStaleMs(base));
  });
});

describe("reconcileStalePortraitBilling", () => {
  it("终态但仍 reserved 的行：出了图就按张数结算", async () => {
    const rows = [task({ status: "partial", completedCount: 2, billingStatus: "reserved" })];
    const { prisma, portraitTask } = fakePrisma(rows);
    const settle = vi.fn(async (_args: unknown) => undefined);

    const fixed = await reconcileStalePortraitBilling({ prisma, settle, staleMs: 1_000, now: () => 100_000 });

    expect(fixed).toBe(1);
    const where = portraitTask.findMany.mock.calls[0]![0].where as {
      status: { in: string[] };
      billingStatus: string;
      updatedAt: { lt: Date };
    };
    // 只认终态 + reserved 这一种组合：这是 runPortraitTask 里 settle 抛了、
    // 但终态照写的那条路径漏出来的行（catch(() => undefined) 吞掉了异常）。
    expect(where.status.in).toEqual(["completed", "partial", "failed", "cancelled"]);
    expect(where.billingStatus).toBe("reserved");
    expect(where.updatedAt.lt).toEqual(new Date(99_000));
    expect(settle).toHaveBeenCalledWith({ task: rows[0], units: 2 });
  });

  it("一张都没出的行按 0 结算，走退款分支", async () => {
    const rows = [task({ status: "failed", completedCount: 0, billingStatus: "reserved" })];
    const { prisma } = fakePrisma(rows);
    const settle = vi.fn(async (_args: unknown) => undefined);

    const fixed = await reconcileStalePortraitBilling({ prisma, settle, staleMs: 1_000, now: () => 100_000 });

    expect(fixed).toBe(1);
    expect(settle).toHaveBeenCalledWith({ task: rows[0], units: 0 });
  });

  it("单行结算失败不影响其余行，失败的行不计入", async () => {
    const rows = [
      task({ id: "t1", completedCount: 1, status: "completed" }),
      task({ id: "t2", completedCount: 1, status: "completed" }),
    ];
    const { prisma } = fakePrisma(rows);
    const settle = vi.fn(async (args: unknown) => {
      if ((args as { task: TaskRow }).task.id === "t1") throw new Error("billing down");
    });

    const fixed = await reconcileStalePortraitBilling({ prisma, settle, staleMs: 1_000, now: () => 100_000 });

    // 失败的留给下一轮：settle 与 refund 在计费侧都按 operationId 幂等，重试安全。
    expect(fixed).toBe(1);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("没有漏账的行时不调计费", async () => {
    const { prisma } = fakePrisma([]);
    const settle = vi.fn(async () => undefined);

    const fixed = await reconcileStalePortraitBilling({ prisma, settle, staleMs: 1_000, now: () => 100_000 });

    expect(fixed).toBe(0);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("startPortraitReaper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("抢不到锁就整轮不做事", async () => {
    vi.useFakeTimers();
    const { prisma, portraitTask } = fakePrisma([task()]);
    const redis = { set: vi.fn(async () => null) };
    const timer = startPortraitReaper({
      prisma,
      redis: redis as never,
      resume: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(timer);

    expect(redis.set).toHaveBeenCalledWith(PORTRAIT_REAPER_LOCK_KEY, "1", "EX", 55, "NX");
    expect(portraitTask.findMany).not.toHaveBeenCalled();
  });

  it("抢到锁跑两遍：先续跑再对账", async () => {
    vi.useFakeTimers();
    const { prisma, portraitTask } = fakePrisma([task()]);
    const resume = vi.fn(async () => undefined);
    const settle = vi.fn(async () => undefined);
    const timer = startPortraitReaper({ prisma, redis: { set: vi.fn(async () => "OK") } as never, resume, settle });

    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(timer);

    expect(portraitTask.findMany).toHaveBeenCalledTimes(2);
    const first = portraitTask.findMany.mock.calls[0]![0].where as { status: { in: string[] } };
    const second = portraitTask.findMany.mock.calls[1]![0].where as { status: { in: string[] }; billingStatus: string };
    expect(first.status.in).toEqual(["pending", "running"]);
    expect(second.billingStatus).toBe("reserved");
    expect(resume).toHaveBeenCalled();
    expect(settle).toHaveBeenCalled();
  });

  it("不立即跑第一轮，等第一个间隔到点", async () => {
    // 启动即扫会和「进程刚起、路由还没注册完」撞上，也会让多实例同时冷启动时
    // 全挤在同一瞬间抢锁。article 那个 reaper 也是这个约定。
    vi.useFakeTimers();
    const { prisma, portraitTask } = fakePrisma([task()]);
    const timer = startPortraitReaper({
      prisma,
      redis: { set: vi.fn(async () => "OK") } as never,
      resume: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(portraitTask.findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(portraitTask.findMany).toHaveBeenCalled();
    clearInterval(timer);
  });
});

/**
 * 接线测试：证明 reaper 真被 portraitWorkflowRoutes 挂起来了，且扫的是全局。
 * 上面那些单测证明的是逻辑，这里证明的是「逻辑真的被调用」——
 * 本任务修的原始缺陷正是「recover 存在但只挂在 GET /state 上」，
 * 逻辑一直是对的，缺的就是这根线。
 */
describe("portraitWorkflowRoutes 的 reaper 接线", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function wiringPrisma() {
    const portraitTask = {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const portraitReferenceAsset = {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    return { portraitTask, portraitReferenceAsset } as unknown as PrismaClient;
  }

  async function buildApp(redis?: { set: ReturnType<typeof vi.fn> }) {
    const app = Fastify();
    const prisma = wiringPrisma();
    app.decorateRequest("userId", "");
    await app.register(portraitWorkflowRoutes, {
      prisma,
      redis: redis as never,
      billing: {
        reserveResource: vi.fn(async () => ({ reserved: 1 })),
        settleResource: vi.fn(async () => ({ settled: 1 })),
        refundResource: vi.fn(async () => ({ success: true })),
      },
      fetchFn: vi.fn() as unknown as typeof fetch,
      scheduleTask: () => undefined,
      storeImage: vi.fn() as never,
      loadStoredImage: vi.fn() as never,
      deleteStoredImage: vi.fn(async () => undefined),
      callImageEdit: vi.fn() as never,
    });
    await app.ready();
    return { app, prisma };
  }

  it("传了 redis 就起主动扫，且扫的是跨用户的超期行", async () => {
    vi.useFakeTimers();
    const redis = { set: vi.fn(async () => "OK") };
    const { app, prisma } = await buildApp(redis);

    await vi.advanceTimersByTimeAsync(60_000);

    const calls = (prisma.portraitTask.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const scan = calls.find(([a]) => (a as { where?: { status?: { in?: string[] } } }).where?.status?.in?.includes("running"));
    expect(scan).toBeDefined();
    const where = (scan![0] as { where: { userId?: unknown; updatedAt?: { lt: Date } } }).where;
    // 这两条就是修复的核心：不限 userId（原来只救当前登录用户）、只捞心跳超期的行。
    expect(where.userId).toBeUndefined();
    expect(where.updatedAt?.lt).toBeInstanceOf(Date);

    await app.close();
  });

  it("不传 redis 不起定时器，只保留 GET /state 的被动 recover", async () => {
    vi.useFakeTimers();
    const { app, prisma } = await buildApp();

    await vi.advanceTimersByTimeAsync(120_000);

    expect((prisma.portraitTask.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    await app.close();
  });

  it("onClose 会停掉 reaper，关服后不再扫", async () => {
    vi.useFakeTimers();
    const redis = { set: vi.fn(async () => "OK") };
    const { app } = await buildApp(redis);

    await vi.advanceTimersByTimeAsync(60_000);
    const before = redis.set.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    await app.close();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(redis.set.mock.calls.length).toBe(before);
  });
});
