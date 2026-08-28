import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { reserveAndCreateTask, runNovelTask, type BillingForNovels, type NovelTaskRow } from "./novel-task-runner.js";
import { novelReservationTtlSeconds } from "./novel-reservation-window.js";

describe("novel task runner idempotency", () => {
  it("does not regenerate or refund a task that a previous delivery already completed", async () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      userId: "user-1",
      targetKind: "chapter",
      targetId: null,
      operationId: "operation-1",
      status: "queued",
      progressPercent: 0,
      progressStage: "queued",
      progressMessage: null,
      progressPreview: "",
      streamedChars: 0,
      requestPayload: {},
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      cancelledAt: null,
    } satisfies NovelTaskRow;
    const prisma = { novelTask: { findUnique: vi.fn(async () => ({ ...task, status: "succeeded" })) } } as unknown as PrismaClient;
    const billing = { reserveResource: vi.fn(), settleResource: vi.fn(), refundResource: vi.fn() } as unknown as BillingForNovels;
    const generator = vi.fn();
    await expect(runNovelTask({ prisma, billing, generator, task })).resolves.toBeUndefined();
    expect(generator).not.toHaveBeenCalled();
    expect(billing.refundResource).not.toHaveBeenCalled();
  });
});

describe("reserveAndCreateTask", () => {
  it("预留时声明有效期：结算要等 worker 接手，10 分钟兜底会先把它按 actual=0 关账", async () => {
    // 关账之后 settle 静默返回 0（wallet.Settle 对非 reserved 记录返回 nil），
    // 成品照发、钱没收到，全程无人报错——所以这里断言的是「有没有声明」，不是数值好看。
    const created = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-1", ...data }));
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ novelTask: { create: created }, novelCommandOutbox: { create: vi.fn(async () => ({})) } }),
    } as unknown as PrismaClient;
    const billing = {
      reserveResource: vi.fn(async () => ({ reserved: 100 })),
      settleResource: vi.fn(),
      refundResource: vi.fn(),
    } as unknown as BillingForNovels;

    await reserveAndCreateTask({
      prisma,
      billing,
      userId: "user-1",
      projectId: "project-1",
      targetKind: "chapter",
      payload: { prompt: "写一章" },
      estimateChars: 100,
    });

    expect(billing.reserveResource).toHaveBeenCalledWith(
      expect.objectContaining({ units: 100, reservationTtlSeconds: novelReservationTtlSeconds() }),
    );
    expect(billing.refundResource).not.toHaveBeenCalled();
  });
});
