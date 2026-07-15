import type { PrismaClient } from "@prisma/client";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendNovelRunEvent: vi.fn(),
  createNextNovelStep: vi.fn(),
}));
vi.mock("./events.js", () => ({ appendNovelRunEvent: mocks.appendNovelRunEvent }));
vi.mock("./run-store.js", () => ({ createNextNovelStep: mocks.createNextNovelStep }));

import { executeNovelEngineStep } from "./runner.js";

describe("novel engine runner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pauses without consuming circuit-breaker attempts when balance is insufficient", async () => {
    const run = {
      id: "run-1",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "writeChapter",
      currentChapter: 1,
      targetCharsPerChapter: 3000,
      autoReview: true,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: null,
    };
    const step = {
      id: "step-1",
      runId: run.id,
      sequence: 1,
      kind: "writeChapter",
      status: "queued",
      chapterNumber: 1,
      input: {},
      run,
    };
    const stepUpdate = vi.fn(async () => step);
    const runUpdate = vi.fn(async () => run);
    const projectUpdate = vi.fn(async () => ({}));
    const prisma = {
      novelRunStep: {
        findUnique: vi.fn(async () => step),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: stepUpdate,
      },
      novelRun: { update: runUpdate },
      novelProject: {
        update: projectUpdate,
        findUniqueOrThrow: vi.fn(async () => ({ id: "project-1", title: "长夜", genre: "玄幻", premise: "追查旧案", settings: {}, narrativeContract: {} })),
      },
      novelChapter: { findUniqueOrThrow: vi.fn(async () => ({ id: "chapter-1", title: "第一章", summary: "开场" })) },
      novelTask: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (input: unknown) => Array.isArray(input) ? Promise.all(input) : undefined),
    } as unknown as PrismaClient;
    const billing = {
      reserveResource: vi.fn(async () => { throw new InsufficientBalanceError(); }),
      settleResource: vi.fn(),
      refundResource: vi.fn(),
    };

    await expect(executeNovelEngineStep({ stepId: step.id, prisma, billing, workerId: "worker-1" })).resolves.toBeUndefined();
    expect(stepUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued", workerId: null }) }));
    expect(runUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "paused", pauseRequested: true }) }));
    expect(projectUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ data: { autopilotStatus: "paused" } }));
    expect(mocks.appendNovelRunEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: "balanceRequired", stage: "paused" }));
  });

  it("persists validateContent before pausing after writeChapter", async () => {
    const run = {
      id: "run-write-pause",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "writeChapter",
      currentChapter: 5,
      targetChapters: 30,
      targetCharsPerChapter: 3000,
      autoReview: true,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: new Date(),
    };
    const freshRun = { ...run, status: "writing", pauseRequested: true };
    const step = { id: "step-write", runId: run.id, sequence: 27, kind: "writeChapter", status: "queued", chapterNumber: 5, input: {}, run };
    const chapter = { id: "chapter-5", title: "第五章", summary: "继续追查", billableChars: 2600 };
    const task = { id: "task-5", status: "succeeded" };
    const prisma = {
      novelRunStep: {
        findUnique: vi.fn(async () => step),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      novelRun: {
        update: vi.fn(async () => freshRun),
        findUniqueOrThrow: vi.fn(async () => freshRun),
      },
      novelProject: {
        findUniqueOrThrow: vi.fn(async () => ({ id: run.projectId, currentBranch: "main" })),
        update: vi.fn(async () => ({})),
      },
      novelChapter: { findUniqueOrThrow: vi.fn(async () => chapter) },
      novelTask: {
        findFirst: vi.fn(async () => task),
        findUniqueOrThrow: vi.fn(async () => task),
      },
    } as unknown as PrismaClient;
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async (input: unknown) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input as Array<Promise<unknown>>);
    });

    await executeNovelEngineStep({ stepId: step.id, prisma, billing: {} as never, workerId: "worker-1" });

    expect(mocks.createNextNovelStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      kind: "validateContent",
      chapterNumber: 5,
    }));
    expect(prisma.novelRun.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    expect(mocks.appendNovelRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "runStatusChanged", stage: "paused", step: "validateContent" }));
  });

  it("persists the next chapter prepare step before pausing after finalizeChapter", async () => {
    const run = {
      id: "run-finalize-pause",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "finalizeChapter",
      currentChapter: 1,
      targetChapters: 30,
      targetCharsPerChapter: 3000,
      autoReview: true,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: new Date(),
    };
    const freshRun = { ...run, status: "postprocessing", pauseRequested: true };
    const step = { id: "step-finalize", runId: run.id, sequence: 8, kind: "finalizeChapter", status: "queued", chapterNumber: 1, input: {}, run };
    const runUpdate = vi.fn(async () => freshRun);
    const projectUpdate = vi.fn(async () => ({}));
    const prisma = {
      novelRunStep: {
        findUnique: vi.fn(async () => step),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      novelRun: { update: runUpdate, findUniqueOrThrow: vi.fn(async () => freshRun) },
      novelProject: {
        findUniqueOrThrow: vi.fn(async () => ({ id: run.projectId, currentBranch: "main" })),
        update: projectUpdate,
      },
      novelChapter: {
        findUniqueOrThrow: vi.fn(async () => ({ id: "chapter-1", content: "第一章正文" })),
        update: vi.fn(async () => ({})),
        findMany: vi.fn(async () => [{ chapterIndex: 1, content: "第一章正文" }]),
      },
      novelQualityReport: {
        findFirst: vi.fn(async () => ({
          gatePassed: true,
          overallScore: 88,
          consistencyScore: 90,
          styleScore: 90,
          tensionScore: 90,
          issues: [],
        })),
      },
    } as unknown as PrismaClient;
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async (input: unknown) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input as Array<Promise<unknown>>);
    });

    await executeNovelEngineStep({ stepId: step.id, prisma, billing: {} as never, workerId: "worker-1" });

    expect(mocks.createNextNovelStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      kind: "prepareChapter",
      chapterNumber: 2,
    }));
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "paused", currentChapter: 2 }) }));
    expect(projectUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ autopilotStatus: "paused" }) }));
  });

  it("automatically revises a failed autopilot quality gate before requiring a human", async () => {
    const run = {
      id: "run-auto-revision",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "finalizeChapter",
      currentChapter: 5,
      targetChapters: 30,
      targetCharsPerChapter: 3000,
      autoReview: true,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: new Date(),
    };
    const freshRun = { ...run, status: "postprocessing" };
    const step = { id: "step-finalize-failed-gate", runId: run.id, sequence: 32, kind: "finalizeChapter", status: "queued", chapterNumber: 5, input: {}, run };
    const chapter = { id: "chapter-5", content: "偏短正文", billableChars: 1793, aiActionItems: ["强化结尾钩子"] };
    const prisma = {
      novelRunStep: {
        findUnique: vi.fn(async () => step),
        updateMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 1),
      },
      novelRun: { update: vi.fn(async () => freshRun), findUniqueOrThrow: vi.fn(async () => freshRun) },
      novelProject: {
        findUniqueOrThrow: vi.fn(async () => ({ id: run.projectId, currentBranch: "main" })),
        update: vi.fn(async () => ({})),
      },
      novelChapter: {
        findUniqueOrThrow: vi.fn(async () => chapter),
        update: vi.fn(async () => ({})),
        findMany: vi.fn(async () => Array.from({ length: 5 }, (_, index) => ({ chapterIndex: index + 1, content: `第${index + 1}章` }))),
      },
      novelQualityReport: {
        findFirst: vi.fn(async () => ({
          gatePassed: false,
          overallScore: 80,
          consistencyScore: 80,
          styleScore: 90,
          tensionScore: 90,
          issues: [],
        })),
      },
    } as unknown as PrismaClient;
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async (input: unknown) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input as Array<Promise<unknown>>);
    });

    await executeNovelEngineStep({ stepId: step.id, prisma, billing: {} as never, workerId: "worker-1" });

    expect(mocks.createNextNovelStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      kind: "writeChapter",
      chapterNumber: 5,
      input: { revisionGuidance: expect.arrayContaining(["当前正文仅 1793 字，重写后不得少于 2700 字", "强化结尾钩子"]) },
      runData: expect.objectContaining({ status: "queued", consecutiveFailures: 0 }),
    }));
    expect(mocks.appendNovelRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "runStatusChanged",
      stage: "queued",
      payload: expect.objectContaining({ reason: "autoRevisionRequested", revisionAttempt: 1, maxRevisionAttempts: 2 }),
    }));
    expect(mocks.appendNovelRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reviewRequired" }));
  });

  it("does not overwrite a cancelled running step with succeeded", async () => {
    const run = {
      id: "run-cancel-race",
      projectId: "project-1",
      userId: "user-1",
      mode: "autopilot",
      status: "queued",
      currentStep: "writeChapter",
      currentChapter: 5,
      targetChapters: 30,
      targetCharsPerChapter: 3000,
      autoReview: true,
      pauseRequested: false,
      cancelRequested: false,
      consecutiveFailures: 0,
      startedAt: new Date(),
    };
    const step = { id: "step-racing", runId: run.id, sequence: 27, kind: "writeChapter", status: "queued", chapterNumber: 5, input: {}, run };
    const task = { id: "task-racing", status: "succeeded" };
    const stepUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const freshRunLookup = vi.fn();
    const prisma = {
      novelRunStep: { findUnique: vi.fn(async () => step), updateMany: stepUpdateMany },
      novelRun: { update: vi.fn(async () => run), findUniqueOrThrow: freshRunLookup },
      novelProject: {
        findUniqueOrThrow: vi.fn(async () => ({ id: run.projectId, currentBranch: "main" })),
        update: vi.fn(async () => ({})),
      },
      novelChapter: { findUniqueOrThrow: vi.fn(async () => ({ id: "chapter-5", title: "第五章", summary: "继续追查", billableChars: 2500 })) },
      novelTask: { findFirst: vi.fn(async () => task), findUniqueOrThrow: vi.fn(async () => task) },
    } as unknown as PrismaClient;
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async (input: unknown) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input as Array<Promise<unknown>>);
    });

    await executeNovelEngineStep({ stepId: step.id, prisma, billing: {} as never, workerId: "worker-1" });

    expect(stepUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: step.id, status: "running", workerId: "worker-1" },
      data: expect.objectContaining({ status: "succeeded" }),
    }));
    expect(freshRunLookup).not.toHaveBeenCalled();
    expect(mocks.createNextNovelStep).not.toHaveBeenCalled();
    expect(mocks.appendNovelRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "stepCompleted" }));
  });
});
