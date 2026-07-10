import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBilling = {
  listModels: vi.fn(),
  upsertModel: vi.fn(),
  updateModelPricing: vi.fn(),
  updateModelDisplay: vi.fn(),
  updateModelIdentity: vi.fn(),
  deleteModel: vi.fn(),
  getModelStats: vi.fn(),
  listEnabledModels: vi.fn(),
};

const requireAdminCalls: string[] = [];

vi.mock("@yc/billing", () => ({
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

vi.mock("@yc/db", () => ({
  getPrisma: () => ({}),
}));

vi.mock("./audit.js", () => ({
  writeAudit: vi.fn(async () => undefined),
}));

async function makeApp() {
  const { adminModelRoutes } = await import("./model-routes.js");
  const app = Fastify();
  await app.register(adminModelRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminCalls.length = 0;
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
});

describe("admin 模型网关路由", () => {
  it("注册时保留 PRICING_MANAGE 和 MODEL_MANAGE 权限边界", async () => {
    const app = await makeApp();
    expect(requireAdminCalls).toContain("PRICING_MANAGE");
    expect(requireAdminCalls.filter((value) => value === "MODEL_MANAGE").length).toBeGreaterThanOrEqual(4);
    await app.close();
  });

  it("POST /api/admin/models 转发模型广场 metadata", async () => {
    mockBilling.upsertModel.mockResolvedValue({ success: true });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/models",
      payload: {
        model: "glm-4.5",
        displayName: "GLM 4.5",
        enabled: true,
        inputPricePerMillion: 100,
        outputPricePerMillion: 200,
        cacheInputPricePerMillion: 50,
        cacheOutputPricePerMillion: 80,
        description: "适合聊天",
        tags: "chat,reasoning",
        contextLength: 128000,
        useCases: "客服",
        sortOrder: 10,
        showInMarketplace: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockBilling.upsertModel).toHaveBeenCalledWith({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      inputPricePerMillion: 100,
      outputPricePerMillion: 200,
      cacheInputPricePerMillion: 50,
      cacheOutputPricePerMillion: 80,
      description: "适合聊天",
      tags: "chat,reasoning",
      contextLength: 128000,
      useCases: "客服",
      sortOrder: 10,
      showInMarketplace: true,
    });
    await app.close();
  });

  it("PATCH /api/admin/models/display 支持 partial marketplace patch", async () => {
    mockBilling.updateModelDisplay.mockResolvedValue({ success: true });
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/models/display",
      payload: {
        model: "glm-4.5",
        displayName: "GLM 4.5",
        enabled: true,
        tags: "chat",
        showInMarketplace: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockBilling.updateModelDisplay).toHaveBeenCalledWith({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      tags: "chat",
      showInMarketplace: true,
    });
    await app.close();
  });

  it("PATCH /api/admin/models/display 非法 metadata 返回 400", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/models/display",
      payload: {
        model: "glm-4.5",
        displayName: "GLM 4.5",
        enabled: true,
        contextLength: -1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockBilling.updateModelDisplay).not.toHaveBeenCalled();
    await app.close();
  });
});
