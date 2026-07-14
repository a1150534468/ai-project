import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBilling = {
  adminListVipLevels: vi.fn(),
  adminUpsertVipLevel: vi.fn(),
  adminDeleteVipLevel: vi.fn(),
};

const requireAdminCalls: string[] = [];

class MockBillingHttpError extends Error {
  constructor(public path: string, public status: number) {
    super(`billing ${path} ${status}`);
    this.name = "BillingHttpError";
  }
}

vi.mock("@ai-assistant/billing", () => ({
  BillingHttpError: MockBillingHttpError,
  createBillingClient: () => mockBilling,
}));

vi.mock("./guard.js", () => ({
  requireAdmin: (permission: string) => {
    requireAdminCalls.push(permission);
    return async (req: object) => {
      Object.assign(req, { admin: { id: "admin-1" } });
    };
  },
}));

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => ({}),
}));

vi.mock("./audit.js", () => ({
  writeAudit: vi.fn(async () => undefined),
}));

async function makeApp() {
  const { adminVipRoutes } = await import("./vip-routes.js");
  const app = Fastify();
  await app.register(adminVipRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminCalls.length = 0;
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
});

describe("admin VIP routes", () => {
  it("GET /api/admin/vip-levels 需要 MEMBERSHIP_MANAGE 并返回列表", async () => {
    mockBilling.adminListVipLevels.mockResolvedValue({
      data: [{ id: 1, name: "普通会员", discountBps: 10000 }],
    });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/vip-levels" });
    expect(res.statusCode).toBe(200);
    expect(requireAdminCalls).toEqual(["MEMBERSHIP_MANAGE", "MEMBERSHIP_MANAGE", "MEMBERSHIP_MANAGE"]);
    expect(res.json().data[0].name).toBe("普通会员");
    await app.close();
  });

  it("POST /api/admin/vip-levels 校验参数并转发", async () => {
    mockBilling.adminUpsertVipLevel.mockResolvedValue({
      success: true,
      data: { id: 2, name: "银卡会员", discountBps: 9000 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels",
      payload: {
        name: "银卡会员",
        sortOrder: 10,
        thresholdRmbFen: 10000,
        discountBps: 9000,
        enabled: true,
        upgradeEnabled: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockBilling.adminUpsertVipLevel).toHaveBeenCalledWith({
      name: "银卡会员",
      sortOrder: 10,
      thresholdRmbFen: 10000,
      discountBps: 9000,
      enabled: true,
      upgradeEnabled: true,
    });
    await app.close();
  });

  it("POST /api/admin/vip-levels 透传 billing 400", async () => {
    mockBilling.adminUpsertVipLevel.mockRejectedValueOnce(new MockBillingHttpError("internal/admin/vip-levels", 400));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels",
      payload: {
        name: "银卡会员",
        sortOrder: 10,
        thresholdRmbFen: 10000,
        discountBps: 9000,
        enabled: true,
        upgradeEnabled: true,
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });


  it("POST /api/admin/vip-levels/delete 非法 id 返回 400", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels/delete",
      payload: { id: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(mockBilling.adminDeleteVipLevel).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /api/admin/vip-levels/delete 区分领域错误和计费不可用", async () => {
    const app = await makeApp();
    mockBilling.adminDeleteVipLevel.mockRejectedValueOnce(new MockBillingHttpError("internal/admin/vip-levels/delete", 404));
    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels/delete",
      payload: { id: 2 },
    });
    expect(missing.statusCode).toBe(404);

    mockBilling.adminDeleteVipLevel.mockRejectedValueOnce(new MockBillingHttpError("internal/admin/vip-levels/delete", 409));
    const conflict = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels/delete",
      payload: { id: 2 },
    });
    expect(conflict.statusCode).toBe(409);

    mockBilling.adminDeleteVipLevel.mockRejectedValueOnce(new Error("fetch failed"));
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/admin/vip-levels/delete",
      payload: { id: 2 },
    });
    expect(unavailable.statusCode).toBe(502);
    await app.close();
  });
});
