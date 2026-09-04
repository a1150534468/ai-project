import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueNovelEngineStep, enqueueNovelGenerationTask } = vi.hoisted(() => ({ enqueueNovelEngineStep: vi.fn(), enqueueNovelGenerationTask: vi.fn() }));
vi.mock("./queue.js", () => ({ enqueueNovelEngineStep, enqueueNovelGenerationTask }));

import { dispatchNovelOutboxBatch, NOVEL_INTERRUPTED_WORK_MS, recoverInterruptedNovelSteps, recoverInterruptedNovelTasks } from "./outbox.js";

const LONG_AGO = new Date("2026-07-14T00:00:00Z");
const STALE_CUTOFF = new Date("2026-07-14T01:00:00Z");
const JUST_NOW = new Date("2026-07-14T02:00:00Z");

type TaskRow = { id: string; projectId: string; status: string; targetKind: string; targetId: string | null; updatedAt: Date };

/**
 * 按 `where` 真过滤的 novelTask.findMany mock。
 *
 * 原来的 mock 是 `findMany: vi.fn(async () => [row])` —— 完全不看 `where`，所以恢复函数的过滤条件
 * 从来没被任何测试钉住，`targetId: null` 漏掉 chapterRewrite 才能一路绿灯混进主干。
 * 遇到不认识的算子直接抛，避免以后改了过滤条件这里又变成假通过。
 */
function matchesWhere(row: TaskRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Record<string, unknown>[]).every((sub) => matchesWhere(row, sub));
    if (key === "OR") return (condition as Record<string, unknown>[]).some((sub) => matchesWhere(row, sub));
    const actual = row[key as keyof TaskRow];
    if (condition === null || typeof condition === "string") return actual === condition;
    if (condition instanceof Date) return (actual as Date).getTime() === condition.getTime();
    const [operator, operand] = Object.entries(condition as Record<string, unknown>)[0] ?? [];
    if (operator === "lt") return (actual as Date).getTime() < (operand as Date).getTime();
    if (operator === "notIn") return !(operand as readonly string[]).includes(actual as string);
    if (operator === "in") return (operand as readonly string[]).includes(actual as string);
    throw new Error(`mock 不认识的 where 算子：${key}.${operator} —— 补上实现，别让测试假通过`);
  });
}

function taskRecoveryPrisma(rows: readonly TaskRow[]) {
  const outboxUpsert = vi.fn(async (_args: { where: { taskId: string } }) => undefined);
  const taskUpdate = vi.fn(async (_args: { where: { id: string } }) => undefined);
  const tx = { novelTask: { update: taskUpdate }, novelCommandOutbox: { upsert: outboxUpsert } };
  const findMany = vi.fn(async (args: { where: Record<string, unknown>; take?: number }) =>
    rows.filter((row) => matchesWhere(row, args.where)).slice(0, args.take ?? rows.length),
  );
  const prisma = {
    novelTask: { findMany },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
  } as unknown as PrismaClient;
  return { prisma, findMany, outboxUpsert, taskUpdate };
}

describe("novel outbox", () => {
  beforeEach(() => {
    enqueueNovelEngineStep.mockReset();
    enqueueNovelGenerationTask.mockReset();
  });

  it("claims and dispatches each command with its stable step id", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      novelCommandOutbox: {
        findMany: vi.fn(async () => [{ id: "outbox-1", stepId: "step-1", priority: 1, attempts: 0 }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => { updates.push(args.data); }),
      },
    } as unknown as PrismaClient;

    await expect(dispatchNovelOutboxBatch(prisma, new Date("2026-07-14T00:00:00Z"))).resolves.toBe(1);
    expect(enqueueNovelEngineStep).toHaveBeenCalledWith("step-1", 1);
    expect(updates).toEqual([expect.objectContaining({ status: "sent", lastError: null })]);
  });

  it("returns a failed dispatch to pending for retry", async () => {
    enqueueNovelEngineStep.mockRejectedValueOnce(new Error("redis unavailable"));
    const update = vi.fn(async () => undefined);
    const prisma = {
      novelCommandOutbox: {
        findMany: vi.fn(async () => [{ id: "outbox-1", stepId: "step-1", priority: 5, attempts: 2 }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update,
      },
    } as unknown as PrismaClient;

    await expect(dispatchNovelOutboxBatch(prisma)).resolves.toBe(0);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "outbox-1" },
      data: expect.objectContaining({ status: "pending", lastError: "redis unavailable" }),
    }));
  });

  it("dispatches setup generation tasks through the same durable outbox", async () => {
    const prisma = {
      novelCommandOutbox: {
        findMany: vi.fn(async () => [{ id: "outbox-generation", stepId: null, taskId: "task-1", priority: 1, attempts: 0 }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => undefined),
      },
    } as unknown as PrismaClient;
    await expect(dispatchNovelOutboxBatch(prisma)).resolves.toBe(1);
    expect(enqueueNovelGenerationTask).toHaveBeenCalledWith("task-1");
    expect(enqueueNovelEngineStep).not.toHaveBeenCalled();
  });

  it("recovers stale running steps transactionally", async () => {
    expect(NOVEL_INTERRUPTED_WORK_MS).toBe(90_000);
    const stepUpdate = vi.fn(async () => undefined);
    const outboxUpsert = vi.fn(async () => undefined);
    const tx = {
      novelRunStep: { update: stepUpdate },
      novelRun: { findUniqueOrThrow: vi.fn(async () => ({ projectId: "project-1" })) },
      novelCommandOutbox: { upsert: outboxUpsert },
    };
    const prisma = {
      novelRunStep: { findMany: vi.fn(async () => [{ id: "step-1", runId: "run-1", priority: 5 }]) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
    } as unknown as PrismaClient;

    await expect(recoverInterruptedNovelSteps(prisma, new Date("2026-07-14T00:00:00Z"))).resolves.toBe(1);
    expect(stepUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued", workerId: null }) }));
    expect(outboxUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stepId: "step-1" },
      update: expect.objectContaining({ status: "pending", sentAt: null }),
    }));
  });

  it("recovers queued generation tasks that may have lost their Redis job", async () => {
    const { prisma, outboxUpsert } = taskRecoveryPrisma([
      { id: "task-1", projectId: "project-1", status: "queued", targetKind: "setupBible", targetId: null, updatedAt: LONG_AGO },
    ]);
    await expect(recoverInterruptedNovelTasks(prisma)).resolves.toBe(1);
    expect(outboxUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: "task-1" }, update: expect.objectContaining({ status: "pending" }) }));
  });

  // P0.6 查出的缺口：`targetId: null` 把 chapterRewrite 一起排除了（它 targetId 存的是章节 id，
  // 不是 step id），于是卡死的改写任务没人续跑，还会把该章节的改写入口 409 锁死。
  it("recovers a stuck chapterRewrite task but never one owned by an engine step", async () => {
    const { prisma, outboxUpsert, taskUpdate } = taskRecoveryPrisma([
      { id: "setup", projectId: "project-1", status: "queued", targetKind: "setupPlot", targetId: null, updatedAt: LONG_AGO },
      { id: "chapter-route", projectId: "project-1", status: "running", targetKind: "chapter", targetId: null, updatedAt: LONG_AGO },
      { id: "rewrite", projectId: "project-1", status: "running", targetKind: "chapterRewrite", targetId: "chapter-9", updatedAt: LONG_AGO },
      { id: "chapter-engine", projectId: "project-1", status: "running", targetKind: "chapter", targetId: "step-7", updatedAt: LONG_AGO },
      { id: "fresh-rewrite", projectId: "project-1", status: "running", targetKind: "chapterRewrite", targetId: "chapter-3", updatedAt: JUST_NOW },
    ]);

    await expect(recoverInterruptedNovelTasks(prisma, STALE_CUTOFF, STALE_CUTOFF)).resolves.toBe(3);
    const recovered = outboxUpsert.mock.calls.map(([args]) => args.where.taskId);
    expect(recovered).toEqual(["setup", "chapter-route", "rewrite"]);
    // step 持有的 task 由步骤恢复负责（步骤重排 → 引擎按 targetId 找回同一行续跑）。
    // 这里再捞一次就是同一份生成重复入队，烧两次模型调用。
    expect(recovered).not.toContain("chapter-engine");
    // 未超时的不该被抢走重跑。
    expect(recovered).not.toContain("fresh-rewrite");
    expect(taskUpdate.mock.calls.map(([args]) => args.where.id)).toEqual(["chapter-route", "rewrite"]);
  });
});
