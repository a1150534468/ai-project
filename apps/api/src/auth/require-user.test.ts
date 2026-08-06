import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { requireUser } from "./require-user.js";

/** 按 server.ts 的真实形状建 app：decorateRequest 给默认空串，onRequest 从头里取 userId。 */
async function appWithAuth(register: (app: FastifyInstance) => Promise<void> | void) {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    if (typeof header === "string") req.userId = header;
  });
  await register(app);
  await app.ready();
  return app;
}

describe("requireUser", () => {
  it("未登录时返回和内联守卫逐字节一致的 401", async () => {
    const app = await appWithAuth((a) => {
      a.get("/thing", { preHandler: requireUser }, async () => ({ ok: true }));
    });
    const res = await app.inject({ method: "GET", url: "/thing" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "未登录" });
    await app.close();
  });

  it("已登录时放行，handler 里能直接用 req.userId", async () => {
    const app = await appWithAuth((a) => {
      a.get("/thing", { preHandler: requireUser }, async (req) => ({ userId: req.userId }));
    });
    const res = await app.inject({ method: "GET", url: "/thing", headers: { "x-test-user": "user-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "user-1" });
    await app.close();
  });

  it("全空白的 userId 算未登录", async () => {
    const app = await appWithAuth((a) => {
      a.get("/thing", { preHandler: requireUser }, async () => ({ ok: true }));
    });
    const res = await app.inject({ method: "GET", url: "/thing", headers: { "x-test-user": "   " } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("未登录时 handler 一次都不会执行", async () => {
    let handlerRuns = 0;
    const app = await appWithAuth((a) => {
      a.get("/thing", { preHandler: requireUser }, async () => {
        handlerRuns += 1;
        return { ok: true };
      });
    });
    await app.inject({ method: "GET", url: "/thing" });
    expect(handlerRuns).toBe(0);
    await app.inject({ method: "GET", url: "/thing", headers: { "x-test-user": "user-1" } });
    expect(handlerRuns).toBe(1);
    await app.close();
  });

  /**
   * 这条是 P1.1 Step 3 整套迁移策略的地基：只要它成立，就能在「所有路由都必须登录」的
   * 插件里挂一个 addHook 覆盖全部路由，而不用逐个改。它一旦挂了（钩子跨插件泄漏），
   * 所有公开路由 —— 供应商回调、签名 URL、登录注册 —— 都会被打成 401。
   */
  it("插件级钩子只作用于本插件，不泄漏到兄弟插件和父作用域", async () => {
    const app = await appWithAuth(async (a) => {
      await a.register(async (guarded) => {
        guarded.addHook("preHandler", requireUser);
        guarded.get("/guarded/a", async () => ({ from: "guarded-a" }));
        guarded.get("/guarded/b", async () => ({ from: "guarded-b" }));
      });
      await a.register(async (open) => {
        open.get("/open/callback", async () => ({ from: "open" }));
      });
      a.get("/root", async () => ({ from: "root" }));
    });

    for (const url of ["/guarded/a", "/guarded/b"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} 该被守卫拦住`).toBe(401);
    }
    for (const url of ["/open/callback", "/root"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} 不该被守卫波及`).toBe(200);
    }
    await app.close();
  });

  it("插件级钩子在已登录时对本插件全部路由放行", async () => {
    const app = await appWithAuth(async (a) => {
      await a.register(async (guarded) => {
        guarded.addHook("preHandler", requireUser);
        guarded.get("/guarded/a", async (req) => ({ userId: req.userId }));
        guarded.post("/guarded/b", async (req) => ({ userId: req.userId }));
      });
    });
    const get = await app.inject({ method: "GET", url: "/guarded/a", headers: { "x-test-user": "u" } });
    const post = await app.inject({ method: "POST", url: "/guarded/b", headers: { "x-test-user": "u" } });
    expect([get.statusCode, post.statusCode]).toEqual([200, 200]);
    expect([get.json(), post.json()]).toEqual([{ userId: "u" }, { userId: "u" }]);
    await app.close();
  });
});
