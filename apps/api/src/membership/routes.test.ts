import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { membershipUserRoutes } from "./routes.js";

const mockBilling = {
  listEnabledCards: vi.fn(),
  buyMembership: vi.fn(),
  myMemberships: vi.fn(),
};

vi.mock("@yc/billing", () => ({
  createBillingClient: () => mockBilling,
}));

async function makeApp(userId = "u1") {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = userId;
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
    mockBilling.buyMembership.mockResolvedValue({ payUrl: "http://pay.url", tradeNo: "yc_mem" });
    const app = await makeApp("current-user");
    const r = await app.inject({
      method: "POST",
      url: "/api/membership/buy",
      payload: { cardId: 1, method: "wxpay" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().tradeNo).toBe("yc_mem");
    expect(mockBilling.buyMembership).toHaveBeenCalledWith("current-user", 1, "wxpay");
    await app.close();
  });
});
