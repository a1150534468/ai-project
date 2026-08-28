import { describe, expect, it, vi } from "vitest";
import { reapStaleArticleWorkflowProjects } from "./article-workflow-reaper.js";
import { ARTICLE_PROJECT_STALE_MS, articleProjectStaleMs } from "./article-workflow-shared.js";
import { ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS } from "./article-workflow-retry.js";

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

  it("默认阈值盖住一个出图批次的最坏耗时，不误杀在跑的项目", async () => {
    // 回归：阈值曾写死 15 分钟，而出图批次含系统兜底重试后最坏可达 20 分钟，
    // 两行卡在 35% 被 reaper 判成「服务重启或任务超时」。
    const env = { IMAGE_ATTEMPT_TIMEOUT_MS: "600000", ARTICLE_WORKFLOW_RETRY_BASE_MS: "2000" };
    const worstChunkMs = ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS * 600_000;
    expect(articleProjectStaleMs(env)).toBeGreaterThan(worstChunkMs);

    const { prisma, articleWorkflowProject } = fakePrisma([]);
    const billing = fakeBilling();
    await reapStaleArticleWorkflowProjects({ prisma, billing, env, now: () => 10_000_000 });
    const where = articleWorkflowProject.findMany.mock.calls[0]![0].where as { updatedAt: { lt: Date } };
    expect(where.updatedAt.lt).toEqual(new Date(10_000_000 - articleProjectStaleMs(env)));
  });

  it("出图超时调小时阈值跟着收紧，卡死的行不必白等", () => {
    const tight = articleProjectStaleMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "60000" });
    const loose = articleProjectStaleMs({ IMAGE_ATTEMPT_TIMEOUT_MS: "600000" });
    expect(tight).toBeLessThan(loose);
    // 但不低于兜底下限，避免把正常的单批出图判成卡死。
    expect(tight).toBe(ARTICLE_PROJECT_STALE_MS);
  });

  it("阈值把共享派发闸门的排队等待算进去：排队期间不写进度心跳", () => {
    const base = { IMAGE_ATTEMPT_TIMEOUT_MS: "600000" };
    const queued = articleProjectStaleMs({ ...base, IMAGE_UPSTREAM_QUEUE_WAIT_MS: "300000" });
    const noGate = articleProjectStaleMs({ ...base, IMAGE_UPSTREAM_CONCURRENCY: "0" });
    // 一个批次里每次尝试都可能先排队，所以差值是 排队上限 × 尝试次数 × 1.5 余量。
    expect(queued - noGate).toBe(ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS * 300_000 * 1.5);
    expect(noGate).toBeLessThan(articleProjectStaleMs(base));
  });
});
