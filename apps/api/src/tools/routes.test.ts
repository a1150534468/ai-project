import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { toolRoutes } from "./routes.js";

/**
 * 本文件只测「登录守卫」这一层。
 *
 * P1.1 把 3 个受保护路由的内联 401 守卫换成了逐路由 `{ preHandler: requireUser }`，
 * 顺手删掉了本文件里的 `userIdFromRequest` 双断言助手。
 *
 * 不能挂插件级钩子：`/api/tool-market` 和 `/api/tool-market/:key` 是公开技能目录，
 * 未登录也要能看（落地页要列工具）。所以守卫逐路由挂，一条断言只钉一条路由。
 *
 * 本域原先没有路由测试文件（只有 market-tools / tool-mounts 两个纯函数测试），
 * 3 个守卫删干净也是全绿 —— 而 /api/tools/install 会拿着空 userId 去派发本机安装，
 * DELETE /api/tools/:toolName 会用空 userId 去 updateMany 卸载。
 *
 * `toolRoutes` 直接调 `getPrisma()` / `getDispatcher()`（都无注入口），所以整模块 mock。
 */
const mocks = vi.hoisted(() => {
  const userToolInstall = {
    findMany: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  };
  const device = { findMany: vi.fn() };
  const dispatchTool = vi.fn();
  return { userToolInstall, device, dispatchTool };
});

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => ({ userToolInstall: mocks.userToolInstall, device: mocks.device }),
}));

vi.mock("../connector/hub.js", () => ({
  getDispatcher: () => ({ dispatchTool: mocks.dispatchTool }),
}));

async function makeApp(userId: string) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(toolRoutes);
  await app.ready();
  return app;
}

describe("工具路由", () => {
  it("未登录时 3 个受保护路由逐条返回 401，且不碰数据库和 Connector", async () => {
    const app = await makeApp("");
    const cases = [
      { method: "GET" as const, url: "/api/tools/installed" },
      {
        method: "POST" as const,
        url: "/api/tools/install",
        payload: { categoryKey: "office", marketId: "skill-1" },
      },
      { method: "DELETE" as const, url: "/api/tools/some_tool" },
    ];
    for (const one of cases) {
      const r = await app.inject(one);
      expect(r.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(r.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    for (const [name, fn] of Object.entries(mocks.userToolInstall)) {
      expect(fn, `userToolInstall.${name} 不该被调用`).not.toHaveBeenCalled();
    }
    expect(mocks.device.findMany).not.toHaveBeenCalled();
    expect(mocks.dispatchTool, "守卫失效时安装会真派发到本机").not.toHaveBeenCalled();
    await app.close();
  });

  it("公开技能目录未登录也能看", async () => {
    // 反证：这两条故意没挂 preHandler。未登录返 200 才说明守卫没误伤公开目录，
    // 同时也证明上一条不是「路由压根没注册」造成的假通过。
    const app = await makeApp("");
    const list = await app.inject({ method: "GET", url: "/api/tool-market" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { success: boolean }).success).toBe(true);

    const unknown = await app.inject({ method: "GET", url: "/api/tool-market/不存在的分类" });
    // 未登录能走到 handler 自己的分类校验，返 404 而不是 401。
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("已登录时守卫放行，请求走到 handler", async () => {
    mocks.userToolInstall.findMany.mockResolvedValue([]);
    // installed 路由要拿在线设备挑 active，不给默认值会在 pickActiveDevice 上抛，
    // 500 会被误读成「守卫没放行」。
    mocks.device.findMany.mockResolvedValue([]);
    const app = await makeApp("user-1");
    const r = await app.inject({ method: "GET", url: "/api/tools/installed" });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: { currentDeviceOnline: boolean } }).data.currentDeviceOnline).toBe(false);
    expect(mocks.userToolInstall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", status: "installed" } }),
    );
    await app.close();
  });
});
