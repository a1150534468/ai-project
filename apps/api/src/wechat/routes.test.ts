import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { wechatRoutes } from "./routes.js";

/**
 * 本文件只测「登录守卫」这一层。
 *
 * 三个路由的业务逻辑在 `bindings.ts`，已由 `bindings.test.ts` 用纯函数 + prisma mock 覆盖；
 * 这里补的是 P1.1 换成插件级 requireUser 后没人钉住的部分 —— 本域原先连测试文件都没有，
 * 三个守卫删干净也是全绿，而绑定接口能把别人的设备接到自己账号上。
 *
 * `wechatRoutes` 直接调 `getPrisma()`（无注入口），所以整个模块 mock 掉。守卫生效时
 * handler 一行都不跑，prisma 一次都不该被碰 —— 这正好成为断言：
 * `getPrisma` 被调用（插件注册时）但下面的表方法一次没调。
 */
const mocks = vi.hoisted(() => {
  const wechatBinding = {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  };
  const device = { findUnique: vi.fn(), findMany: vi.fn() };
  return { wechatBinding, device };
});

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => ({ wechatBinding: mocks.wechatBinding, device: mocks.device }),
}));

async function makeApp(userId: string) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(wechatRoutes);
  await app.ready();
  return app;
}

describe("微信绑定路由", () => {
  it("未登录时全部路由返回 401，且不碰数据库", async () => {
    const app = await makeApp("");
    const cases = [
      {
        method: "POST" as const,
        url: "/api/wechat/bindings",
        payload: { deviceId: "dev1", targetType: "agent", targetId: "a1" },
      },
      { method: "GET" as const, url: "/api/wechat/bindings" },
      { method: "DELETE" as const, url: "/api/wechat/bindings/b1" },
    ];
    for (const one of cases) {
      const r = await app.inject(one);
      expect(r.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(r.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    for (const [name, fn] of Object.entries(mocks.wechatBinding)) {
      expect(fn, `wechatBinding.${name} 不该被调用`).not.toHaveBeenCalled();
    }
    expect(mocks.device.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("已登录时守卫放行，请求走到 handler", async () => {
    // 反向证明上一条不是「路由压根没注册」造成的假通过：同样的 URL，带上 userId 就不再是 401。
    mocks.wechatBinding.findMany.mockResolvedValue([]);
    // listBindings 拿 rows 的 deviceId 去查在线状态，不给默认值这里会在 .map 上抛，
    // 500 会被误读成「守卫没放行」。
    mocks.device.findMany.mockResolvedValue([]);
    const app = await makeApp("user-1");
    const r = await app.inject({ method: "GET", url: "/api/wechat/bindings" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: [] });
    expect(mocks.wechatBinding.findMany).toHaveBeenCalled();
    await app.close();
  });
});
