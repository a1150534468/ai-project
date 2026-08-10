import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { membershipUserRoutes } from "./routes.js";

const mockBilling = {
  listEnabledCards: vi.fn(),
  buyMembership: vi.fn(),
  myMemberships: vi.fn(),
};

vi.mock("@ai-assistant/billing", () => ({
  createBillingClient: () => mockBilling,
}));

async function makeApp(userId = "u1") {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  await app.register(membershipUserRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
});

describe("用户会员路由", () => {
  it("POST /api/membership/buy 透传用户选择的支付方式", async () => {
    mockBilling.buyMembership.mockResolvedValue({ payUrl: "http://pay.url", tradeNo: "ai_mem" });
    const app = await makeApp("current-user");
    const r = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      payload: { cardId: 1, method: "wxpay" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().tradeNo).toBe("ai_mem");
    expect(mockBilling.buyMembership).toHaveBeenCalledWith("current-user", 1, "wxpay");
    await app.close();
  });

  /**
   * P1.1 把本文件 3 个路由的内联 401 守卫换成了插件级 requireUser preHandler。
   * 原先这里一条 401 断言都没有。buy 是真花钱的路由，守卫必须钉住。
   */
  it("未登录时全部路由返回 401，且不碰计费服务", async () => {
    const app = await makeApp("");
    const cases = [
      { method: "GET" as const, url: "/api/membership/cards" },
      { method: "POST" as const, url: "/api/membership/buy", payload: { cardId: 1, method: "wxpay" } },
      { method: "GET" as const, url: "/api/membership/mine" },
    ];
    for (const one of cases) {
      const r = await app.inject(one);
      expect(r.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(r.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
    expect(mockBilling.listEnabledCards).not.toHaveBeenCalled();
    expect(mockBilling.buyMembership).not.toHaveBeenCalled();
    expect(mockBilling.myMemberships).not.toHaveBeenCalled();
    await app.close();
  });
});
