import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { comicWorkflowRoutes } from "./comic-routes.js";
import type { ComicProjectStore } from "./comic-project-service.js";

function now(): Date {
  return new Date("2026-07-02T07:00:00.000Z");
}

function createStore(): ComicProjectStore {
  const projects: Array<{
    readonly id: string;
    readonly userId: string;
    readonly title: string;
    readonly logline: string;
    readonly style: string;
    readonly status: string;
    readonly currentStage: string;
    readonly settings: unknown;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }> = [];

  const store: ComicProjectStore = {
    comicWorkflowProject: {
      create: vi.fn(async (args) => {
        const row = {
          id: `project-${projects.length + 1}`,
          status: "active",
          currentStage: "script",
          settings: {},
          createdAt: now(),
          updatedAt: now(),
          ...args.data,
        };
        projects.push(row);
        return row;
      }),
      findMany: vi.fn(async (args) => projects.filter((project) => project.userId === args.where.userId)),
      findFirst: vi.fn(async (args) => {
        const project = projects.find((row) => (
          (!args.where.id || row.id === args.where.id) &&
          (!args.where.userId || row.userId === args.where.userId)
        ));
        if (!project) return null;
        if (!args.include) return project;
        return { ...project, bibleEntries: [], episodes: [] };
      }),
      update: vi.fn(async (args) => {
        const project = projects.find((row) => row.id === args.where.id);
        if (!project) throw new Error("project not found");
        const updated = { ...project, ...args.data, updatedAt: now() };
        projects.splice(projects.indexOf(project), 1, updated);
        return updated;
      }),
      delete: vi.fn(async (args) => {
        const project = projects.find((row) => row.id === args.where.id);
        if (!project) throw new Error("project not found");
        projects.splice(projects.indexOf(project), 1);
        return project;
      }),
    },
    comicWorkflowBibleEntry: {
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
      delete: vi.fn(),
    },
    comicWorkflowEpisode: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
    },
    comicWorkflowScriptVersion: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (callback) => callback(store)),
  };
  return store;
}

async function buildApp(store: ComicProjectStore) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-user-id"];
    if (typeof header === "string") Object.defineProperty(req, "userId", { value: header, writable: true });
  });
  await app.register(comicWorkflowRoutes, { store });
  return app;
}

describe("comic workflow routes", () => {
  it("rejects unauthenticated project listing", async () => {
    const app = await buildApp(createStore());
    const response = await app.inject({ method: "GET", url: "/api/workflow/comics/projects" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates and returns a comic project for the current user", async () => {
    const app = await buildApp(createStore());
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/workflow/comics/projects",
      headers: { "x-user-id": "user-1" },
      payload: { title: "霓虹侦探社", logline: "失忆侦探追查城市幻影", style: "赛博都市" },
    });
    expect(createResponse.statusCode).toBe(201);
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/workflow/comics/projects",
      headers: { "x-user-id": "user-1" },
    });
    expect(listResponse.json()).toMatchObject({
      success: true,
      data: [{ id: "project-1", title: "霓虹侦探社", currentStage: "script" }],
    });
    await app.close();
  });

  it("does not expose another user's project", async () => {
    const app = await buildApp(createStore());
    await app.inject({
      method: "POST",
      url: "/api/workflow/comics/projects",
      headers: { "x-user-id": "user-1" },
      payload: { title: "霓虹侦探社" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/workflow/comics/projects/project-1",
      headers: { "x-user-id": "user-2" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
