import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueNovelEngineStep, enqueueNovelGenerationTask } = vi.hoisted(() => ({ enqueueNovelEngineStep: vi.fn(), enqueueNovelGenerationTask: vi.fn() }));
vi.mock("./queue.js", () => ({ enqueueNovelEngineStep, enqueueNovelGenerationTask }));

import { dispatchNovelOutboxBatch, recoverInterruptedNovelSteps, recoverInterruptedNovelTasks } from "./outbox.js";

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
    const outboxUpsert = vi.fn(async () => undefined);
    const tx = { novelTask: { update: vi.fn() }, novelCommandOutbox: { upsert: outboxUpsert } };
    const prisma = {
      novelTask: { findMany: vi.fn(async () => [{ id: "task-1", projectId: "project-1", status: "queued" }]) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
    } as unknown as PrismaClient;
    await expect(recoverInterruptedNovelTasks(prisma)).resolves.toBe(1);
    expect(outboxUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: "task-1" }, update: expect.objectContaining({ status: "pending" }) }));
  });
});
