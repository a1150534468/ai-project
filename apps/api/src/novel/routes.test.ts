import Fastify from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    novelChapter: { findFirst: vi.fn(async () => null) },
    novelRun: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string; userId: string } }) => where.id === run.id && where.projectId === run.projectId && where.userId === run.userId ? run : null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...run, ...data, updatedAt: now })),
      findMany: vi.fn(async () => [run]),
    },
    novelRunStep: { updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
    novelRunEvent: { findMany: vi.fn(async () => []) },
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

  it("refuses to resume a completed run", async () => {
    const completed = { ...run, status: "completed" };
    const prisma = prismaMock({ novelRun: { findFirst: vi.fn(async () => completed) } });
    const app = await buildApp(prisma);
    const response = await app.inject({ method: "POST", url: `/api/workflow/novels/projects/${project.id}/runs/${run.id}/resume` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("不能恢复");
    await app.close();
  });
});
