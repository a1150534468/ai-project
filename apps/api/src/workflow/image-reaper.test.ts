import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_REAPER_LOCK_KEY,
  reconcileStaleImageBilling,
  scanStaleImageTasks,
  startImageReaper,
} from "./image-reaper.js";
import { DEFAULT_STALE_TASK_MS, type ImageGenerationTaskRow } from "./image-shared.js";

const NOW = new Date("2026-08-05T12:00:00.000Z").getTime();

function makeRow(overrides: Partial<ImageGenerationTaskRow> = {}): ImageGenerationTaskRow {
  return {
    id: "task-1",
    userId: "user-1",
    requestId: "req-1",
    prompt: "一只猫",
    model: "seedream-4",
    size: "1024x1024",
    count: 1,
    status: "running",
    completedCount: 0,
    error: null,
    billingMode: "reserve",
    billingResourceKey: "image.seedream-4",
    billingReservedUnits: 1,
    billingSettledUnits: null,
    billingStatus: "reserved",
    createdAt: new Date(NOW - 3_600_000),
    updatedAt: new Date(NOW - 3_600_000),
    ...overrides,
  };
}

interface FindManyArgs {
  readonly where: {
    readonly status?: string | { readonly in: readonly string[] };
    readonly billingMode?: string;
    readonly billingStatus?: { readonly in: readonly string[] };
    readonly updatedAt: { readonly lt: Date };
  };
  readonly orderBy?: unknown;
  readonly take?: number;
}

function makePrisma(rows: ImageGenerationTaskRow[]) {
  const findMany = vi.fn(async (_args: FindManyArgs) => rows);
  return { prisma: { imageGenerationTask: { findMany } } as never, findMany };
}

/** 断言 status 是 `{ in: [...] }` 形状时用，省得每处现场 cast。 */
function statusIn(where: FindManyArgs["where"]): readonly string[] {
  return (where.status as { readonly in: readonly string[] }).in;
}

describe("scanStaleImageTasks", () => {
  it("用户不轮询也能捞到卡住的 running 行并交回续跑", async () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b", requestId: "req-2" })];
    const { prisma, findMany } = makePrisma(rows);
    const resume = vi.fn(async (_rows: readonly ImageGenerationTaskRow[]) => 2);

    const resumed = await scanStaleImageTasks({ prisma, resume, now: () => NOW });

    expect(resumed).toBe(2);
    // 关键：整批一次交回，而不是逐行——image 的 resumeStaleTasks 吃 tasks 数组
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toEqual(rows);

    const where = findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("running");
    expect(where.updatedAt.lt.getTime()).toBe(NOW - DEFAULT_STALE_TASK_MS);
  });

  it("一行都没有时不调 resume", async () => {
    const { prisma } = makePrisma([]);
    const resume = vi.fn(async () => 0);
    await expect(scanStaleImageTasks({ prisma, resume, now: () => NOW })).resolves.toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it("batch 上限生效，默认 200，可覆盖", async () => {
    const { prisma, findMany } = makePrisma([]);
    const resume = vi.fn(async () => 0);

    await scanStaleImageTasks({ prisma, resume, now: () => NOW });
    expect(findMany.mock.calls[0]![0].take).toBe(200);

    await scanStaleImageTasks({ prisma, resume, take: 5, now: () => NOW });
    expect(findMany.mock.calls[1]![0].take).toBe(5);
  });

  it("不加 select：整行透传，否则续跑会缺 referenceAssetIds/count 这类列", async () => {
    const { prisma, findMany } = makePrisma([]);
    await scanStaleImageTasks({ prisma, resume: async () => 0, now: () => NOW });
    expect(findMany.mock.calls[0]![0]).not.toHaveProperty("select");
  });

  it("阈值可被 IMAGE_STALE_TASK_MS 覆盖", async () => {
    const { prisma, findMany } = makePrisma([]);
    await scanStaleImageTasks({
      prisma,
      resume: async () => 0,
      env: { IMAGE_STALE_TASK_MS: "60000" } as NodeJS.ProcessEnv,
      now: () => NOW,
    });
    expect(findMany.mock.calls[0]![0].where.updatedAt.lt.getTime()).toBe(NOW - 60_000);
  });

  it("resume 抛异常不把整轮带崩", async () => {
    const { prisma } = makePrisma([makeRow()]);
    const resume = vi.fn(async () => {
      throw new Error("prisma down");
    });
    await expect(scanStaleImageTasks({ prisma, resume, now: () => NOW })).resolves.toBe(0);
  });
});

describe("reconcileStaleImageBilling", () => {
  // 这条是 P0.4 计划缺陷的回归用例：计划让对账扫「非终态」，
  // 而漏账的行恰恰是状态已写成终态、结算没落地的那些。照计划写永远捞零行。
  it("对账扫的是终态而不是 running", async () => {
    const { prisma, findMany } = makePrisma([]);
    await reconcileStaleImageBilling({ prisma, reconcile: async () => 0, now: () => NOW });

    const where = findMany.mock.calls[0]![0].where;
    expect(statusIn(where)).toEqual(["completed", "failed", "cancelled"]);
    expect(statusIn(where)).not.toContain("running");
    expect(where.billingMode).toBe("reserve");
    expect(where.billingStatus?.in).toEqual(["reserved", "settle_failed", "settling"]);
    expect(where.updatedAt.lt.getTime()).toBe(NOW - DEFAULT_STALE_TASK_MS);
  });

  it("捞到终态漏账行时整批交回对账", async () => {
    const rows = [
      makeRow({ id: "c", status: "completed", completedCount: 1 }),
      makeRow({ id: "d", status: "failed", billingStatus: "settle_failed" }),
    ];
    const { prisma } = makePrisma(rows);
    const reconcile = vi.fn(async (_rows: readonly ImageGenerationTaskRow[]) => 2);

    await expect(reconcileStaleImageBilling({ prisma, reconcile, now: () => NOW })).resolves.toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![0]).toEqual(rows);
  });

  it("reconcile 抛异常留给下一轮，不影响返回", async () => {
    const { prisma } = makePrisma([makeRow({ status: "completed" })]);
    const reconcile = vi.fn(async () => {
      throw new Error("billing down");
    });
    await expect(reconcileStaleImageBilling({ prisma, reconcile, now: () => NOW })).resolves.toBe(0);
  });

  it("batch 上限生效", async () => {
    const { prisma, findMany } = makePrisma([]);
    await reconcileStaleImageBilling({ prisma, reconcile: async () => 0, take: 7, now: () => NOW });
    expect(findMany.mock.calls[0]![0].take).toBe(7);
  });
});

describe("startImageReaper", () => {
  function makeRedis(result: "OK" | null) {
    return { set: vi.fn(async () => result) } as never;
  }

  it("抢到锁才扫，两趟都跑", async () => {
    vi.useFakeTimers();
    try {
      const { prisma } = makePrisma([]);
      const redis = makeRedis("OK");
      const resume = vi.fn(async () => 0);
      const reconcile = vi.fn(async () => 0);

      const timer = startImageReaper({ prisma, redis, resume, reconcile });
      await vi.advanceTimersByTimeAsync(60_000);
      clearInterval(timer);

      expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
        IMAGE_REAPER_LOCK_KEY,
        "1",
        "EX",
        55,
        "NX",
      );
      // 两趟都跑到：findMany 被调两次（续跑一趟 + 对账一趟）
      expect((prisma as unknown as { imageGenerationTask: { findMany: ReturnType<typeof vi.fn> } })
        .imageGenerationTask.findMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("抢不到锁就整轮跳过，避免多实例重复拉起同一批任务", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([makeRow()]);
      const timer = startImageReaper({
        prisma,
        redis: makeRedis(null),
        resume: async () => 0,
        reconcile: async () => 0,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      clearInterval(timer);
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("不立即跑一轮：启动瞬间抢锁会和刚起的实例互相打断", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([]);
      const timer = startImageReaper({
        prisma,
        redis: makeRedis("OK"),
        resume: async () => 0,
        reconcile: async () => 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(findMany).not.toHaveBeenCalled();
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timer 是 unref 的，不吊住进程退出", async () => {
    vi.useFakeTimers();
    try {
      const { prisma } = makePrisma([]);
      const timer = startImageReaper({
        prisma,
        redis: makeRedis("OK"),
        resume: async () => 0,
        reconcile: async () => 0,
      });
      expect(timer.hasRef()).toBe(false);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redis 挂了当没抢到锁，不抛到定时器外", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, findMany } = makePrisma([]);
      const redis = { set: vi.fn(async () => { throw new Error("redis down"); }) } as never;
      const timer = startImageReaper({ prisma, redis, resume: async () => 0, reconcile: async () => 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      clearInterval(timer);
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("扫描抛异常走 onError，不吞掉", async () => {
    vi.useFakeTimers();
    try {
      const findMany = vi.fn(async () => { throw new Error("db down"); });
      const prisma = { imageGenerationTask: { findMany } } as never;
      const onError = vi.fn();
      const timer = startImageReaper({
        prisma,
        redis: makeRedis("OK"),
        resume: async () => 0,
        reconcile: async () => 0,
        onError,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      clearInterval(timer);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
