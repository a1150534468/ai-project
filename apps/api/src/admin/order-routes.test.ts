import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBilling = {
  listAdminOrders: vi.fn(),
};

const mockPrisma = {
  user: {
    findMany: vi.fn(),
  },
};

const requireAdminCalls: string[] = [];

vi.mock("@ai-assistant/billing", () => ({
  createBillingClient: () => mockBilling,
}));

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => mockPrisma,
}));

vi.mock("./guard.js", () => ({
  requireAdmin: (permission: string) => {
    requireAdminCalls.push(permission);
    return async (req: object) => {
      Object.assign(req, { admin: { id: "admin-1" } });
    };
  },
}));

async function makeApp() {
  const { adminOrderRoutes } = await import("./order-routes.js");
  const app = Fastify();
  await app.register(adminOrderRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminCalls.length = 0;
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
  mockBilling.listAdminOrders.mockResolvedValue({
    data: [],
    total: 0,
    summary: { total: 0, successCount: 0, pendingCount: 0, closedCount: 0, successAmountFen: 0, successPoints: 0, payingUsers: 0 },
  });
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe("admin 订单管理路由", () => {
  it("注册时使用 ORDER_MANAGE 权限", async () => {
    const app = await makeApp();
    expect(requireAdminCalls).toContain("ORDER_MANAGE");
    await app.close();
  });

  it("按用户关键词解析用户后转发订单筛选", async () => {
    mockPrisma.user.findMany
      .mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }])
      .mockResolvedValueOnce([
        { id: "u1", uid: "87736716", username: "xingye" },
        { id: "u2", uid: "10000001", username: "test" },
      ]);
    mockBilling.listAdminOrders.mockResolvedValue({
      data: [
        { id: 1, tradeNo: "ai1", userId: "u1", amountFen: 100, points: 700, provider: "epay", paymentMethod: "alipay", status: "success", kind: "points", cardId: 0, createdAt: "2026-07-02T08:16:00Z", paidAt: "2026-07-02T08:16:10Z" },
      ],
      total: 1,
      summary: { total: 1, successCount: 1, pendingCount: 0, closedCount: 0, successAmountFen: 100, successPoints: 700, payingUsers: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/orders?user=xingye&status=success&kind=points&limit=50",
    });
    expect(res.statusCode).toBe(200);
    expect(mockBilling.listAdminOrders).toHaveBeenCalledWith(expect.objectContaining({
      userIds: ["u1", "u2"],
      status: "success",
      kind: "points",
      limit: 50,
    }));
    expect(res.json().data[0].user.username).toBe("xingye");
    await app.close();
  });

  it("用户关键词无匹配时不请求 billing", async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/orders?user=missing" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    expect(mockBilling.listAdminOrders).not.toHaveBeenCalled();
    await app.close();
  });
});
