import Fastify from "fastify";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { billingRoutes } from "./routes.js";

const mockBilling = {
  createTopup: vi.fn(),
  listRechargePackages: vi.fn(),
  getRechargeRatio: vi.fn(),
  listUsage: vi.fn(),
  getVipSummary: vi.fn(),
  listModelMarketplace: vi.fn(),
  getTopupOrder: vi.fn(),
  redeem: vi.fn(),
  getBalance: vi.fn(),
};

vi.mock("@ai-assistant/billing", () => ({
  InsufficientBalanceError: class InsufficientBalanceError extends Error {},
  createBillingClient: () => mockBilling,
}));

async function makeApp(userId = "u1") {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = userId;
  });
  await app.register(billingRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
});

describe("用户计费路由", () => {
  it("GET /api/billing/recharge-ratio 返回充值汇率", async () => {
    mockBilling.getRechargeRatio.mockResolvedValue({ ratio: 120 });
    const app = await makeApp();
    const r = await app.inject({ method: "GET", url: "/api/billing/recharge-ratio" });
    expect(r.statusCode).toBe(200);
    expect(r.json().ratio).toBe(120);
    await app.close();
  });

  it("GET /api/billing/usage 使用当前登录用户查询消耗明细", async () => {
    mockBilling.listUsage.mockResolvedValue({
      data: [{
        operationId: "op1",
        type: "chat",
        model: "m",
        actualPoints: 2,
        originalPoints: 3,
        vipLevelName: "银卡会员",
        vipDiscountBps: 9000,
        vipSavedPoints: 1,
        vipGrowthPoints: 2,
        createdAt: "2026-06-29T00:00:00Z",
      }],
    });
    const app = await makeApp("current-user");
    const r = await app.inject({ method: "GET", url: "/api/billing/usage?limit=5" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].actualPoints).toBe(2);
    expect(r.json().data[0].originalPoints).toBe(3);
    expect(r.json().data[0].vipGrowthPoints).toBe(2);
    expect(mockBilling.listUsage).toHaveBeenCalledWith("current-user", 5);
    await app.close();
  });

  it("POST /api/billing/topup 支持视频点自定义充值", async () => {
    mockBilling.createTopup.mockResolvedValue({ payUrl: "https://pay.example/qrcode", tradeNo: "video-1" });
    const app = await makeApp("current-user");
    const r = await app.inject({
      method: "POST",
      url: "/api/billing/topup",
      payload: { accountType: "video", amountFen: 2500, method: "alipay" },
    });
    expect(r.statusCode).toBe(200);
    expect(mockBilling.createTopup).toHaveBeenCalledWith({
      userId: "current-user",
      accountType: "video",
      amountFen: 2500,
      method: "alipay",
    });
    await app.close();
  });

  it("POST /api/billing/topup 拒绝视频点套餐充值", async () => {
    const app = await makeApp("current-user");
    const r = await app.inject({
      method: "POST",
      url: "/api/billing/topup",
      payload: { accountType: "video", packageId: "standard", method: "alipay" },
    });
    expect(r.statusCode).toBe(400);
    expect(mockBilling.createTopup).not.toHaveBeenCalled();
    await app.close();
  });

  it("GET /api/billing/balance 返回算力点和视频点余额", async () => {
    mockBilling.getBalance.mockResolvedValue({ balance: 700, videoBalance: 2500 });
    const app = await makeApp("current-user");
    const r = await app.inject({ method: "GET", url: "/api/billing/balance" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ balance: 700, videoBalance: 2500 });
    expect(mockBilling.getBalance).toHaveBeenCalledWith("current-user");
    await app.close();
  });

  it("GET /api/vip/me 只使用当前登录用户查询 VIP summary", async () => {
    mockBilling.getVipSummary.mockResolvedValue({
      data: {
        userId: "current-user",
        levelId: 2,
        levelName: "银卡会员",
        discountBps: 9000,
        growthPoints: 10000,
        nextLevelId: 3,
        nextLevelName: "金卡会员",
        nextThreshold: 30000,
        pointsToNextLevel: 20000,
        highestLevel: false,
      },
    });
    const app = await makeApp("current-user");
    const r = await app.inject({ method: "GET", url: "/api/vip/me?userId=hacker" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.levelName).toBe("银卡会员");
    expect(mockBilling.getVipSummary).toHaveBeenCalledWith("current-user");
    await app.close();
  });

  it("GET /api/model-marketplace 只使用当前登录用户查询模型广场", async () => {
    mockBilling.listModelMarketplace.mockResolvedValue({
      data: [{
        model: "glm-4.5",
        displayName: "GLM 4.5",
        enabled: true,
        description: "适合聊天",
        tags: "chat,reasoning",
        contextLength: 128000,
        useCases: "客服",
        sortOrder: 10,
        showInMarketplace: true,
        inputPricePerMillion: 100,
        outputPricePerMillion: 200,
        cacheInputPricePerMillion: 50,
        cacheOutputPricePerMillion: 80,
        inputPriceRmbPerMillion: 1,
        outputPriceRmbPerMillion: 2,
        cacheInputPriceRmbPerMillion: 0.5,
        cacheOutputPriceRmbPerMillion: 0.8,
        vipInputPrice: { original: 100, discounted: 90 },
        vipOutputPrice: { original: 200, discounted: 180 },
        vipCacheInputPrice: { original: 50, discounted: 45 },
        vipCacheOutputPrice: { original: 80, discounted: 72 },
      }],
      vip: {
        userId: "current-user",
        levelId: 2,
        levelName: "银卡会员",
        discountBps: 9000,
        growthPoints: 10000,
        nextLevelId: 3,
        nextLevelName: "金卡会员",
        nextThreshold: 30000,
        pointsToNextLevel: 20000,
        highestLevel: false,
      },
    });
    const app = await makeApp("current-user");
    const r = await app.inject({ method: "GET", url: "/api/model-marketplace?userId=hacker" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data[0].showInMarketplace).toBe(true);
    expect(r.json().vip.discountBps).toBe(9000);
    expect(mockBilling.listModelMarketplace).toHaveBeenCalledWith("current-user");
    await app.close();
  });

  it("GET /api/billing/topup/:tradeNo 只允许查询当前登录用户的支付订单", async () => {
    mockBilling.getTopupOrder.mockResolvedValue({
      data: {
        tradeNo: "ai123",
        userId: "current-user",
        amountFen: 100,
        points: 100,
        provider: "epay",
        paymentMethod: "alipay",
        status: "success",
        kind: "points",
        cardId: 0,
        createdAt: "2026-07-02T08:45:36Z",
        paidAt: "2026-07-02T08:45:47Z",
      },
    });
    const app = await makeApp("current-user");
    const r = await app.inject({ method: "GET", url: "/api/billing/topup/ai123?userId=hacker" });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.status).toBe("success");
    expect(mockBilling.getTopupOrder).toHaveBeenCalledWith("current-user", "ai123");
    await app.close();
  });
});
