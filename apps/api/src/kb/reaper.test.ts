import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { reapOnce, startKbReaper } from "./reaper.js";
import type { IndexDeps } from "./indexer.js";

function prismaWithBatches(exhausted: unknown[] = [], candidates: unknown[] = []) {
  const findMany = vi.fn()
    .mockResolvedValueOnce(exhausted)
    .mockResolvedValueOnce(candidates);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    prisma: { document: { findMany, updateMany } } as unknown as PrismaClient,
    findMany,
    updateMany,
  };
}

const opts = (runIndex = vi.fn(async () => undefined)) => ({
  leaseMs: 300_000,
  maxAttempts: 3,
  batchSize: 20,
  runIndex,
});

describe("reapOnce", () => {
  it("先终态化耗尽租约，再 oldest-first 处理剩余候选", async () => {
    const fixture = prismaWithBatches(
      [{ id: "dead", lockedBy: "old:attempt" }],
      [{ id: "pending" }, { id: "expired" }],
    );
    const runIndex = vi.fn(async () => undefined);
    await expect(reapOnce(fixture.prisma, opts(runIndex))).resolves.toBe(3);
    expect(fixture.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "dead", lockedBy: "old:attempt" }),
      data: expect.objectContaining({ status: "failed", lockedBy: null, lockedAt: null }),
    }));
    expect(runIndex.mock.calls.map((call: unknown[]) => call[0])).toEqual(["pending", "expired"]);
    expect(fixture.findMany.mock.calls[0][0]).toMatchObject({
      where: { status: "indexing", attempts: { gte: 3 } },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    expect(fixture.findMany.mock.calls[1][0]).toMatchObject({
      where: { attempts: { lt: 3 } },
      orderBy: { createdAt: "asc" },
      take: 19,
    });
  });

  it("单篇失败继续后续文档，processed 只计成功", async () => {
    const fixture = prismaWithBatches([], [{ id: "a" }, { id: "bad" }, { id: "c" }]);
    const runIndex = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("boom");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(reapOnce(fixture.prisma, opts(runIndex))).resolves.toBe(2);
    expect(runIndex.mock.calls.map(([id]) => id)).toEqual(["a", "bad", "c"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bad: boom"));
    log.mockRestore();
  });

  it("stop 标志在候选查询前或文档边界停止普通批次", async () => {
    const fixture = prismaWithBatches([], [{ id: "a" }, { id: "b" }]);
    let stopped = false;
    const runIndex = vi.fn(async () => { stopped = true; });
    await expect(reapOnce(fixture.prisma, {
      ...opts(runIndex),
      shouldStop: () => stopped,
    })).resolves.toBe(1);
    expect(runIndex).toHaveBeenCalledOnce();
  });
});

function stubDeps(ids: readonly string[]): IndexDeps {
  const findMany = vi.fn(async (args: { where?: { attempts?: { gte?: number } } }) =>
    args.where?.attempts?.gte === undefined ? ids.map((id) => ({ id })) : []);
  return {
    prisma: { document: { findMany, updateMany: vi.fn() } } as unknown as PrismaClient,
    loadObject: vi.fn(),
    parse: vi.fn(),
    chunk: vi.fn(),
    embed: vi.fn(),
    workerId: "reaper-test",
  };
}

describe("startKbReaper", () => {
  const TIMER_OPTS = { intervalMs: 100, leaseMs: 300_000, maxAttempts: 3, batchSize: 20 };

  it("每个 tick 一轮，stop 后没有新轮", async () => {
    vi.useFakeTimers();
    try {
      const runIndex = vi.fn(async () => undefined);
      const reaper = startKbReaper(stubDeps(["a", "b"]), { ...TIMER_OPTS, runIndex });
      await vi.advanceTimersByTimeAsync(200);
      expect(runIndex).toHaveBeenCalledTimes(4);
      reaper.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runIndex).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("上一轮未完成时跳过后续 tick", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const runIndex = vi.fn(async () => gate);
      const reaper = startKbReaper(stubDeps(["a"]), { ...TIMER_OPTS, runIndex });
      await vi.advanceTimersByTimeAsync(600);
      expect(runIndex).toHaveBeenCalledOnce();
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(runIndex).toHaveBeenCalledTimes(2);
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("当前普通批次在文档边界响应 stop", async () => {
    vi.useFakeTimers();
    try {
      let reaper!: { stop: () => void };
      const runIndex = vi.fn(async () => reaper.stop());
      reaper = startKbReaper(stubDeps(["a", "b", "c"]), { ...TIMER_OPTS, runIndex });
      await vi.advanceTimersByTimeAsync(100);
      expect(runIndex).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
