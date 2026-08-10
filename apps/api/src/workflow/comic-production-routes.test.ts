import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { comicProductionRoutes } from "./comic-production-routes.js";

/**
 * 本文件只测「登录守卫」这一层。
 *
 * P1.1 把 14 个受保护路由的内联 401 守卫换成了逐路由 `{ preHandler: requireUser }`，
 * 顺手删掉了 comic-production-helpers.ts 里的 `userIdFrom` 助手（14 处调用点全没了）。
 *
 * 不能挂插件级钩子：GET /api/workflow/comics/video/models 是静态模型目录，
 * 未登录也要能看。所以守卫逐路由挂，一条断言只钉一条路由。
 *
 * 本域原先没有路由测试文件，14 个守卫删干净也是全绿 —— 而 generate-image /
 * generate-video 会拿着空 userId 真去打生图和视频供应商，assets / shots 那几条
 * 是按 userId 过滤的，空 userId 直接把归属校验废掉。
 */

/** 只需要证明「守卫拦下时一次都没碰」，所以全部方法都是空 mock。 */
function createPrismaMock() {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  });
  return {
    comicWorkflowProject: model(),
    comicWorkflowAsset: model(),
    comicWorkflowEpisode: model(),
    comicWorkflowShot: model(),
    comicWorkflowScriptVersion: model(),
  };
}

async function makeApp(userId: string, prisma: ReturnType<typeof createPrismaMock>, fetchFn: typeof fetch) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(comicProductionRoutes, {
    prisma: prisma as unknown as PrismaClient,
    fetchFn,
    env: {
      IMAGE_GENERATION_ENDPOINT: "https://image.test/v1",
      IMAGE_API_KEY: "image-key",
      ARK_API_KEY: "ark-key",
    } as NodeJS.ProcessEnv,
  });
  await app.ready();
  return app;
}

describe("漫画成片路由", () => {
  it("未登录时 14 个受保护路由逐条返回 401，且不碰数据库和供应商", async () => {
    const prisma = createPrismaMock();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = await makeApp("", prisma, fetchFn);
    const cases: ReadonlyArray<{
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/api/workflow/comics/projects/p1/assets" },
      {
        method: "POST",
        url: "/api/workflow/comics/projects/p1/assets",
        payload: { type: "character", name: "小明" },
      },
      { method: "PATCH", url: "/api/workflow/comics/assets/a1", payload: { name: "改名" } },
      { method: "DELETE", url: "/api/workflow/comics/assets/a1" },
      { method: "POST", url: "/api/workflow/comics/assets/a1/generate-image", payload: {} },
      { method: "GET", url: "/api/workflow/comics/episodes/e1/shots" },
      {
        method: "POST",
        url: "/api/workflow/comics/episodes/e1/shots",
        payload: { description: "第一镜" },
      },
      { method: "POST", url: "/api/workflow/comics/episodes/e1/shots/generate", payload: {} },
      { method: "PATCH", url: "/api/workflow/comics/shots/s1", payload: { title: "改题" } },
      { method: "DELETE", url: "/api/workflow/comics/shots/s1" },
      { method: "POST", url: "/api/workflow/comics/shots/s1/generate-image", payload: {} },
      { method: "POST", url: "/api/workflow/comics/shots/s1/generate-video", payload: {} },
      { method: "POST", url: "/api/workflow/comics/shots/s1/poll-video", payload: {} },
      { method: "POST", url: "/api/workflow/comics/episodes/e1/render", payload: {} },
    ];
    expect(cases).toHaveLength(14);
    for (const one of cases) {
      const r = await app.inject(one);
      expect(r.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(r.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    for (const [modelName, methods] of Object.entries(prisma)) {
      for (const [name, fn] of Object.entries(methods)) {
        expect(fn, `${modelName}.${name} 不该被调用`).not.toHaveBeenCalled();
      }
    }
    expect(fetchFn, "守卫失效时生图/生视频会真打供应商").not.toHaveBeenCalled();
    await app.close();
  });

  it("公开视频模型目录未登录也能看", async () => {
    // 反证：这条故意没挂 preHandler。未登录返 200 才说明守卫没误伤它，
    // 同时也证明上一条不是「路由压根没注册」造成的假通过。
    const prisma = createPrismaMock();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = await makeApp("", prisma, fetchFn);
    const r = await app.inject({ method: "GET", url: "/api/workflow/comics/video/models" });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: readonly unknown[] }).data.length).toBeGreaterThan(0);
    await app.close();
  });

  it("已登录时守卫放行，请求走到 handler", async () => {
    // 反向证明 401 不是「所有请求都 401」：带上 userId 后走进 handler，
    // 项目查不到时返 404（handler 自己的判断），而不是 401。
    const prisma = createPrismaMock();
    prisma.comicWorkflowProject.findFirst.mockResolvedValue(null);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = await makeApp("user-1", prisma, fetchFn);
    const r = await app.inject({ method: "GET", url: "/api/workflow/comics/projects/p1/assets" });
    expect(r.statusCode).toBe(404);
    expect(prisma.comicWorkflowProject.findFirst).toHaveBeenCalledWith({
      where: { id: "p1", userId: "user-1" },
    });
    await app.close();
  });
});
