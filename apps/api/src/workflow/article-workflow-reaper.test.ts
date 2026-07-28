import { describe, expect, it, vi } from "vitest";
import { reapStaleArticleWorkflowProjects } from "./article-workflow-reaper.js";

type StuckRow = { id: string; status: string; billingOperationId: string | null };

function fakePrisma(rows: StuckRow[], claimCount = 1) {
  const articleWorkflowProject = {
    findMany: vi.fn(async (_args: { where: unknown; select: unknown }) => rows),
    updateMany: vi.fn(async (_args: { where: unknown; data: unknown }) => ({ count: claimCount })),
  };
  return { prisma: { articleWorkflowProject } as never, articleWorkflowProject };
}

function fakeBilling() {
  return { refundResource: vi.fn(async (_operationId: string) => ({ success: true })) };
}

describe("reapStaleArticleWorkflowProjects", () => {
  it("超期 generating 项目置 failed 并退款", async () => {
    const { prisma, articleWorkflowProject } = fakePrisma([
      { id: "p1", status: "generating", billingOperationId: "article-text:p1:abc" },
    ]);
    const billing = fakeBilling();

    const reaped = await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 });

    expect(reaped).toBe(1);
    const where = articleWorkflowProject.findMany.mock.calls[0]![0].where as {
      status: { in: string[] };
      updatedAt: { lt: Date };
    };
    expect(where.status.in).toEqual(["generating", "revising"]);
    expect(where.updatedAt.lt).toEqual(new Date(99_000));
    expect(articleWorkflowProject.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "p1", status: "generating" },
      data: { status: "failed", progressStage: "failed", progressPercent: 100 },
    });
    expect(billing.refundResource).toHaveBeenCalledWith("article-text:p1:abc");
  });

  it("抢占失败（count=0）不退款", async () => {
    const { prisma } = fakePrisma([{ id: "p1", status: "generating", billingOperationId: "op" }], 0);
    const billing = fakeBilling();

    const reaped = await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 });

    expect(reaped).toBe(0);
    expect(billing.refundResource).not.toHaveBeenCalled();
  });

  it("无 billingOperationId 只置 failed 不退款", async () => {
    const { prisma, articleWorkflowProject } = fakePrisma([
      { id: "p1", status: "revising", billingOperationId: null },
    ]);
    const billing = fakeBilling();

    const reaped = await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 });

    expect(reaped).toBe(1);
    expect(articleWorkflowProject.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "p1", status: "revising" },
    });
    expect(billing.refundResource).not.toHaveBeenCalled();
  });

  it("退款失败不影响其余项目收尸", async () => {
    const { prisma, articleWorkflowProject } = fakePrisma([
      { id: "p1", status: "generating", billingOperationId: "op1" },
      { id: "p2", status: "revising", billingOperationId: "op2" },
    ]);
    const billing = {
      refundResource: vi.fn(async (operationId: string) => {
        if (operationId === "op1") throw new Error("billing down");
        return { success: true };
      }),
    };

    const reaped = await reapStaleArticleWorkflowProjects({ prisma, billing, staleMs: 1_000, now: () => 100_000 });

    expect(reaped).toBe(2);
    expect(articleWorkflowProject.updateMany).toHaveBeenCalledTimes(2);
    expect(billing.refundResource).toHaveBeenCalledTimes(2);
  });
});
