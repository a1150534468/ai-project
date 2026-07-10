import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { reportRoutes } from "./report-routes.js";

function buildApp(deps: Parameters<typeof reportRoutes>[1]) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as { userId?: string }).userId = "u1";
  });
  return app.register((a) => reportRoutes(a, deps));
}

describe("report-routes", () => {
  it("POST 文本 → 建任务、fire run、返回 taskId", async () => {
    const create = vi.fn().mockResolvedValue({ id: "t1", stage: "pending" });
    const run = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      prisma: {
        reportTask: {
          create,
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
      } as never,
      run,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/reports",
      payload: {
        text: "一段长文字",
        intent: "季度总结",
        model: "MiniMax-M3",
        exhaustive: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.taskId).toBe("t1");
    expect(create).toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    // exhaustive 透传给 run
    expect(run.mock.calls[0][0]).toMatchObject({ exhaustive: true });
  });

  it("POST 缺 text 且非文件 → 400", async () => {
    const app = buildApp({
      prisma: {
        reportTask: {
          create: vi.fn(),
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
      } as never,
      run: vi.fn(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/workflow/reports",
      payload: { model: "MiniMax-M3" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET :id 仅返回本人任务，越权 404", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const app = buildApp({
      prisma: {
        reportTask: {
          create: vi.fn(),
          findFirst,
          findMany: vi.fn(),
        },
      } as never,
      run: vi.fn(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/workflow/reports/tX",
    });
    expect(res.statusCode).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "tX", userId: "u1" },
    });
  });

  it("GET history 只查本人", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const app = buildApp({
      prisma: {
        reportTask: {
          create: vi.fn(),
          findFirst: vi.fn(),
          findMany,
        },
      } as never,
      run: vi.fn(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/workflow/reports/history",
    });
    expect(res.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        take: 20,
      })
    );
  });

  it("GET :id/download ready 才给链接，否则 409", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "t1",
      userId: "u1",
      stage: "running",
      htmlKey: null,
    });
    const app = buildApp({
      prisma: {
        reportTask: {
          create: vi.fn(),
          findFirst,
          findMany: vi.fn(),
        },
      } as never,
      run: vi.fn(),
      publicUrlOf: (k: string) => `https://cdn/${k}`,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/workflow/reports/t1/download",
    });
    expect(res.statusCode).toBe(409);
  });
});
