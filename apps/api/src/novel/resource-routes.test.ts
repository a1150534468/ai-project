import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { registerNovelResourceRoutes } from "./resource-routes.js";

function checkpointPrisma(active = false) {
  const projectUpdate = vi.fn(async () => ({}));
  const chapterCreate = vi.fn(async () => ({}));
  const checkpoint = {
    id: "checkpoint-1",
    projectId: "project-1",
    branchName: "world-b",
    chapterNumber: 1,
    label: "第一章后",
    isHead: false,
    snapshot: {
      project: { title: "旧世界线", genre: "玄幻", premise: "前提", settings: {}, generationPrefs: {}, narrativeContract: {}, storyPhase: "opening" },
      chapters: [{ chapterIndex: 1, title: "初见", content: "章节正文", rawContent: "章节正文", status: "ready", reviewStatus: "approved", billableChars: 4 }],
    },
  };
  const tx = {
    novelProject: { update: projectUpdate },
    novelChapter: { deleteMany: vi.fn(async () => ({ count: 1 })), create: chapterCreate },
    novelCheckpoint: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => checkpoint), create: vi.fn(async () => checkpoint) },
  };
  const prisma = {
    novelProject: { findFirst: vi.fn(async () => ({ id: "project-1", userId: "user-1" })) },
    novelRun: { findFirst: vi.fn(async () => active ? { id: "run-1" } : null) },
    novelCheckpoint: { findFirst: vi.fn(async () => checkpoint) },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  return { prisma, projectUpdate, chapterCreate };
}

async function appFor(prisma: PrismaClient) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request) => { (request as typeof request & { userId: string }).userId = "user-1"; });
  await registerNovelResourceRoutes(app, { prisma });
  return app;
}

describe("novel checkpoint resources", () => {
  it("restores the project and chapters while switching branches", async () => {
    const state = checkpointPrisma();
    const app = await appFor(state.prisma);
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints/checkpoint-1/rollback" });
    expect(response.statusCode).toBe(200);
    expect(state.projectUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentBranch: "world-b", title: "旧世界线" }) }));
    expect(state.chapterCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ chapterIndex: 1, content: "章节正文" }) }));
    await app.close();
  });

  it("blocks rollback while a resumable run still owns the book", async () => {
    const state = checkpointPrisma(true);
    const app = await appFor(state.prisma);
    const response = await app.inject({ method: "POST", url: "/api/workflow/novels/projects/project-1/checkpoints/checkpoint-1/rollback" });
    expect(response.statusCode).toBe(409);
    expect(state.projectUpdate).not.toHaveBeenCalled();
    await app.close();
  });
});
