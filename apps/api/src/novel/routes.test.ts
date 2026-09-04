import Fastify from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendNovelRunEvent: vi.fn(async () => undefined),
  createNovelRun: vi.fn(),
  createNextNovelStep: vi.fn(),
  dispatchNovelOutboxBatch: vi.fn(async () => 1),
}));

vi.mock("./run-store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./run-store.js")>(),
  createNovelRun: mocks.createNovelRun,
  createNextNovelStep: mocks.createNextNovelStep,
}));
vi.mock("./outbox.js", () => ({ dispatchNovelOutboxBatch: mocks.dispatchNovelOutboxBatch }));
vi.mock("./events.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./events.js")>(),
  appendNovelRunEvent: mocks.appendNovelRunEvent,
}));
vi.mock("@ai-assistant/db", () => ({
  getPrisma: vi.fn(),
  getRedis: vi.fn(() => ({ duplicate: vi.fn() })),
}));

import { novelEngineRoutes } from "./routes.js";

const now = new Date("2026-07-14T08:00:00.000Z");
const project = { id: "project-1", userId: "user-1", targetChapters: 100 };
const run = {
  id: "run-1",
  projectId: project.id,
  userId: project.userId,
  mode: "autopilot",
  status: "queued",
  currentStep: "prepareChapter",
  currentChapter: 1,
  targetChapters: 10,
  targetCharsPerChapter: 3000,
  completedChapters: 0,
  consecutiveFailures: 0,
  pauseRequested: false,
  cancelRequested: false,
  error: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
};

function prismaMock(overrides: Record<string, unknown> = {}): PrismaClient {
  return {
    novelProject: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => where.id === project.id && where.userId === project.userId ? project : null),
      update: vi.fn(async () => project),
    },
    novelChapter: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    novelRun: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string; userId: string } }) => where.id === run.id && where.projectId === run.projectId && where.userId === run.userId ? run : null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...run, ...data, updatedAt: now })),
      findMany: vi.fn(async () => [run]),
    },
    novelRunStep: { updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    novelTask: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    novelCommandOutbox: { updateMany: vi.fn(async () => ({ count: 0 })) },
    novelRunEvent: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    ...overrides,
  } as unknown as PrismaClient;
}

async function buildApp(prisma: PrismaClient, userId = "user-1") {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request) => { (request as typeof request & { userId: string }).userId = userId; });
  await novelEngineRoutes(app, { prisma });
  return app;
}

describe("novel engine routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchNovelOutboxBatch.mockResolvedValue(1);
    mocks.createNovelRun.mockResolvedValue({ run, step: { id: "step-1" } });
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not expose or start another user's project", async () => {
    const app = await buildApp(prismaMock(), "user-2");
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 10, targetCharsPerChapter: 3000, autoReview: true },
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.createNovelRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates an autopilot run and asks the outbox dispatcher to deliver it", async () => {
    const app = await buildApp(prismaMock());
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 10, targetCharsPerChapter: 3200, autoReview: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().data.run.id).toBe(run.id);
    expect(mocks.createNovelRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "autopilot", startChapter: 1, targetChapters: 10 }));
    expect(mocks.dispatchNovelOutboxBatch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns the latest generation progress with the running pipeline step", async () => {
    const step = {
      id: "step-write-1",
      runId: run.id,
      sequence: 3,
      kind: "writeChapter",
      status: "running",
      chapterNumber: 1,
      attempt: 1,
      maxAttempts: 3,
      priority: 5,
      progress: 1,
      input: {},
      output: null,
      error: null,
      workerId: "worker-1",
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const progressUpdatedAt = new Date("2026-07-14T08:00:05.000Z");
    const prisma = prismaMock({
      novelRun: { findFirst: vi.fn(async () => ({ ...run, steps: [step] })) },
      novelTask: { findMany: vi.fn(async () => [{
        targetId: step.id,
        status: "running",
        progressPercent: 63,
        progressStage: "streaming",
        progressMessage: "模型正在流式生成，已接收 1,680 字",
        streamedChars: 1680,
        updatedAt: progressUpdatedAt,
      }]) },
    });
    const app = await buildApp(prisma);

    const response = await app.inject({ method: "GET", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.steps[0].taskProgress).toEqual({
      status: "running",
      percent: 63,
      stage: "streaming",
      message: "模型正在流式生成，已接收 1,680 字",
      streamedChars: 1680,
      updatedAt: progressUpdatedAt.toISOString(),
    });
    await app.close();
  });

  it("loads the latest event tail immediately instead of replaying a long run from the beginning", async () => {
    const newest = {
      id: "event-3",
      runId: run.id,
      projectId: project.id,
      sequence: 3,
      type: "stepCompleted",
      stage: "writing",
      step: "writeChapter",
      chapterNumber: 1,
      progress: 100,
      payload: {},
      createdAt: now,
    };
    const prior = { ...newest, id: "event-2", sequence: 2, type: "stepStarted", progress: 1 };
    const findMany = vi.fn(async () => [newest, prior]);
    const prisma = prismaMock({ novelRunEvent: { findMany } });
    const app = await buildApp(prisma);

    const response = await app.inject({ method: "GET", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/events?after=0` });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { sequence: "desc" }, take: 200 }));
    expect(response.json().data.events.map((event: { sequence: number }) => event.sequence)).toEqual([2, 3]);
    expect(response.json().data.cursor).toBe(3);
    await app.close();
  });

  it("starts from the first empty planned chapter instead of the maximum chapter number", async () => {
    const chapters = Array.from({ length: 24 }, (_, index) => ({ chapterIndex: index + 1, content: index === 0 ? "第一章正文" : "" }));
    const prisma = prismaMock({ novelChapter: { findMany: vi.fn(async () => chapters) } });
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 30, targetCharsPerChapter: 3000, startChapter: 2, autoReview: true },
    });
    expect(response.statusCode).toBe(202);
    expect(mocks.createNovelRun).toHaveBeenCalledWith(expect.objectContaining({ startChapter: 2, completedChapters: 1 }));
    await app.close();
  });

  it("starts the next iteration at chapter thirty-one after a completed thirty-chapter run", async () => {
    const chapters = Array.from({ length: 30 }, (_, index) => ({ chapterIndex: index + 1, content: `第 ${index + 1} 章正文` }));
    const prisma = prismaMock({ novelChapter: { findMany: vi.fn(async () => chapters) } });
    const app = await buildApp(prisma);

    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 60, targetCharsPerChapter: 3000, startChapter: 31, autoReview: true },
    });

    expect(response.statusCode).toBe(202);
    expect(mocks.createNovelRun).toHaveBeenCalledWith(expect.objectContaining({
      startChapter: 31,
      targetChapters: 60,
      completedChapters: 30,
    }));
    await app.close();
  });

  it("rejects a stale client that tries to skip planned empty chapters", async () => {
    const prisma = prismaMock({ novelChapter: { findMany: vi.fn(async () => [{ chapterIndex: 1, content: "第一章" }, { chapterIndex: 2, content: "" }, { chapterIndex: 24, content: "" }]) } });
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 30, targetCharsPerChapter: 3000, startChapter: 25, autoReview: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("第 2 章");
    expect(mocks.createNovelRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns conflict when the database enforces one active run per book", async () => {
    mocks.createNovelRun.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("active run", {
      code: "P2002",
      clientVersion: "6.19.3",
    }));
    const app = await buildApp(prismaMock());
    const response = await app.inject({
      method: "POST",
      url: `/api/workflow/novels/projects/${project.id}/runs/autopilot`,
      payload: { targetChapters: 10, targetCharsPerChapter: 3000, autoReview: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("已有运行中");
    await app.close();
  });

  it("pauses a queued run at the durable boundary", async () => {
    const prisma = prismaMock();
    const app = await buildApp(prisma);
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/pause` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.run.status).toBe("paused");
    expect(prisma.novelRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pauseRequested: true }) }));
    await app.close();
  });

  it("cancels running steps and generation tasks", async () => {
    const writing = { ...run, status: "writing", currentStep: "writeChapter", currentChapter: 2 };
    const stepUpdateMany = vi.fn(async () => ({ count: 1 }));
    const taskUpdateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = prismaMock({
      novelRun: {
        findFirst: vi.fn(async () => writing),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...writing, ...data, updatedAt: now })),
      },
      novelRunStep: {
        findMany: vi.fn(async () => [{ id: "step-running" }]),
        updateMany: stepUpdateMany,
      },
      novelTask: {
        findMany: vi.fn(async () => [{ id: "task-running" }]),
        updateMany: taskUpdateMany,
      },
    });
    const app = await buildApp(prisma, "user-1");
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/cancel` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.run.status).toBe("cancelled");
    expect(stepUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: expect.arrayContaining(["queued", "running"]) } }) }));
    expect(taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }));
    expect(mocks.appendNovelRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "runStatusChanged", stage: "cancelled" }));
    await app.close();
  });

  it("refuses to resume a completed run", async () => {
    const completed = { ...run, status: "completed" };
    const prisma = prismaMock({ novelRun: { findFirst: vi.fn(async () => completed) } });
    const app = await buildApp(prisma);
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("不能恢复");
    await app.close();
  });

  it("completes an assisted run after the chapter is manually approved", async () => {
    const awaiting = { ...run, mode: "assisted", status: "awaitingReview", currentChapter: 1 };
    const prisma = prismaMock({
      novelRun: {
        findFirst: vi.fn(async () => awaiting),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...awaiting, ...data, updatedAt: now })),
      },
      novelChapter: { findUnique: vi.fn(async () => ({ reviewStatus: "approved" })) },
    });
    const app = await buildApp(prisma);
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.run.status).toBe("completed");
    expect(mocks.createNextNovelStep).not.toHaveBeenCalled();
    expect(mocks.appendNovelRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "runCompleted", stage: "completed" }));
    await app.close();
  });

  it("does not resume across an unapproved review boundary", async () => {
    const awaiting = { ...run, mode: "autopilot", status: "awaitingReview", currentChapter: 1 };
    const prisma = prismaMock({
      novelRun: { findFirst: vi.fn(async () => awaiting) },
      novelChapter: { findUnique: vi.fn(async () => ({ reviewStatus: "revise" })) },
    });
    const app = await buildApp(prisma);
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("人工审阅");
    expect(mocks.createNextNovelStep).not.toHaveBeenCalled();
    await app.close();
  });

  it("requeues the same chapter for AI revision with quality guidance", async () => {
    const awaiting = { ...run, status: "awaitingReview", currentStep: "finalizeChapter", currentChapter: 5, targetCharsPerChapter: 3000 };
    const prisma = prismaMock({
      novelRun: {
        findFirst: vi.fn(async () => awaiting),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...awaiting, currentStep: "writeChapter", ...data, updatedAt: now })),
      },
      novelChapter: {
        findUnique: vi.fn(async () => ({ reviewStatus: "revise", billableChars: 1793, aiActionItems: ["增加人物对话", "强化结尾钩子"] })),
      },
      novelRunStep: { findFirst: vi.fn(async () => null) },
    });
    const app = await buildApp(prisma);

    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/revise` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.run).toMatchObject({ status: "queued", currentChapter: 5, currentStep: "writeChapter" });
    expect(mocks.createNextNovelStep).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      kind: "writeChapter",
      chapterNumber: 5,
      input: { revisionGuidance: expect.arrayContaining(["当前正文仅 1793 字，重写后不得少于 2700 字", "增加人物对话", "强化结尾钩子"]) },
    }));
    expect(mocks.appendNovelRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "runStatusChanged", stage: "queued", step: "writeChapter" }));
    await app.close();
  });

  it("resumes a failed writeChapter step in place instead of advancing chapters", async () => {
    const failed = { ...run, status: "failed", currentStep: "writeChapter", currentChapter: 5, consecutiveFailures: 3, error: "Connection error." };
    const failedStep = { id: "step-write-5", runId: run.id, sequence: 27, kind: "writeChapter", chapterNumber: 5, status: "failed", priority: 5 };
    const stepUpdate = vi.fn(async () => ({ ...failedStep, status: "queued", error: null }));
    const outboxUpsert = vi.fn(async () => ({}));
    const prisma = prismaMock({
      novelRun: {
        findFirst: vi.fn(async () => failed),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...failed, ...data, updatedAt: now })),
      },
      novelRunStep: {
        findFirst: vi.fn(async () => failedStep),
        update: stepUpdate,
      },
      novelCommandOutbox: { upsert: outboxUpsert },
    });
    const app = await buildApp(prisma);

    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.run).toMatchObject({ status: "queued", currentChapter: 5, currentStep: "writeChapter", consecutiveFailures: 0 });
    expect(stepUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: failedStep.id }, data: expect.objectContaining({ status: "queued" }) }));
    expect(outboxUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { stepId: failedStep.id } }));
    expect(mocks.createNextNovelStep).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * P1.1 把这 10 个路由的内联 401 守卫换成了插件级 requireUser preHandler。
   * 原先本文件一条 401 断言都没有，等于守卫全靠人眼守着 —— 删掉也是全绿。
   * 这条把守卫钉住：未登录必须 401，且 handler 一次都不许跑到查库。
   */
  it("未登录时全部路由返回 401，且不碰数据库", async () => {
    const prisma = prismaMock();
    const app = await buildApp(prisma, "");
    const cases = [
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/assisted` },
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/autopilot` },
      { method: "GET" as const, url: `/api/workflow/novels/projects/${project.id}/runs` },
      { method: "GET" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}` },
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/pause` },
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/cancel` },
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/revise` },
      { method: "POST" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` },
      { method: "GET" as const, url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/events` },
    ];
    for (const one of cases) {
      const response = await app.inject(one);
      expect(response.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(response.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    expect(prisma.novelProject.findFirst).not.toHaveBeenCalled();
    await app.close();
  });
});
