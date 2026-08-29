import { describe, it, expect, vi } from "vitest";
import { BillingHttpError, createBillingClient, InsufficientBalanceError, isSilentSettlement } from "../index.js";

describe("billing client", () => {
  it("reserve 余额不足抛 InsufficientBalanceError", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: "INSUFFICIENT_BALANCE" }), { status: 402 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await expect(c.reserve({ operationId: "op", userId: "u", type: "chat", model: "m", inputTokens: 1, maxOutputTokens: 1 }))
      .rejects.toBeInstanceOf(InsufficientBalanceError);
  });
  it("settle 成功返回 settled", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ settled: 42 }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.settle({ operationId: "op", userId: "u", model: "m", inputTokens: 1, outputTokens: 2 });
    expect(r.settled).toBe(42);
  });
  it("非 402 的 billing 错误保留 HTTP 状态", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await expect(c.adminDeleteVipLevel(99)).rejects.toMatchObject({
      name: "BillingHttpError",
      status: 404,
      path: "internal/admin/vip-levels/delete",
    });
    await expect(c.adminDeleteVipLevel(99)).rejects.toBeInstanceOf(BillingHttpError);
  });
  it("createTopup 返回 payUrl 和 tradeNo", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ payUrl: "http://pay.url", tradeNo: "ai123" }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.createTopup({ userId: "u1", amountFen: 1900, method: "alipay" });
    expect(r.payUrl).toContain("http://pay.url");
    expect(r.tradeNo).toBe("ai123");
  });
  it("createTopup 支持 packageId 下单", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ payUrl: "http://pay.url", tradeNo: "ai_pkg" }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await c.createTopup({ userId: "u1", packageId: "standard", method: "alipay" });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/topup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "u1", packageId: "standard", method: "alipay" }),
      }),
    );
  });
  it("createTopup 支持视频点自定义充值", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ payUrl: "http://pay.url", tradeNo: "ai_video" }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await c.createTopup({ userId: "u1", accountType: "video", amountFen: 2500, method: "alipay" });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/topup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "u1", accountType: "video", amountFen: 2500, method: "alipay" }),
      }),
    );
  });
  it("getTopupOrder 使用当前用户和交易号查询订单状态", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: {
        tradeNo: "ai123",
        userId: "u1",
        amountFen: 100,
        points: 100,
        provider: "epay",
        paymentMethod: "wxpay",
        status: "success",
        kind: "points",
        cardId: 0,
        createdAt: "2026-07-02T08:45:36Z",
        paidAt: "2026-07-02T08:45:47Z",
      },
    }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.getTopupOrder("u1", "ai123");
    expect(r.data.status).toBe("success");
    expect(r.data.paymentMethod).toBe("wxpay");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/topup/u1/ai123",
      expect.objectContaining({ method: "GET" }),
    );
  });
  it("redeem 成功返回 success: true", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.redeem({ code: "CODE1", userId: "u1" });
    expect(r.success).toBe(true);
  });
  it("getBalance 返回算力点和视频点余额", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ balance: 5000, videoBalance: 1200 }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.getBalance("u1");
    expect(r.balance).toBe(5000);
    expect(r.videoBalance).toBe(1200);
  });
  it("listUsage 返回用户消耗记录", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        operationId: "op1",
        type: "chat",
        model: "m",
        actualPoints: 3,
        originalPoints: 4,
        vipLevelName: "银卡会员",
        vipDiscountBps: 9000,
        vipSavedPoints: 1,
        vipGrowthPoints: 3,
        createdAt: "2026-06-29T00:00:00Z",
      }],
    }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.listUsage("u1", 20);
    expect(r.data[0].actualPoints).toBe(3);
    expect(r.data[0].originalPoints).toBe(4);
    expect(r.data[0].vipLevelName).toBe("银卡会员");
    expect(r.data[0].vipGrowthPoints).toBe(3);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/usage/u1?limit=20",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("getVipSummary 和 listModelMarketplace 返回 VIP 视图数据", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/vip/me/")) {
        return new Response(JSON.stringify({
          data: {
            userId: "u1",
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
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
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
          userId: "u1",
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
      }), { status: 200 });
    });
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const vip = await c.getVipSummary("u1");
    const marketplace = await c.listModelMarketplace("u1");
    expect(vip.data.levelName).toBe("银卡会员");
    expect(marketplace.vip.discountBps).toBe(9000);
    expect(marketplace.data[0].tags).toBe("chat,reasoning");
    expect(marketplace.data[0].vipInputPrice.discounted).toBe(90);
  });
});

describe("@ai-assistant/billing admin 扩展", () => {
  it("generateCodes 透传并返回 codes", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ codes: ["A", "B"] }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.generateCodes({ grantType: "BALANCE", grantPayload: '{"points":1}', count: 2 });
    expect(r.codes).toEqual(["A", "B"]);
  });

  it("adjustBalance 402 抛 InsufficientBalanceError", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "insufficient" }), { status: 402 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await expect(
      c.adjustBalance({ operationId: "o1", userId: "u1", delta: -10, reason: "x", adminId: "a1" }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("batchBalances 返回映射", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ balances: { u1: 100 } }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.batchBalances(["u1"]);
    expect(r.balances.u1).toBe(100);
  });

  it("listEnabledModels 返回 data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ model: "m", displayName: "M" }] }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.listEnabledModels();
    expect(r.data[0].model).toBe("m");
  });

  it("模型身份、删除和统计接口走内部管理路径", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ data: { model: "m2", displayName: "模型二", totalPoints: 33, usageCount: 2 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await c.updateModelIdentity({ model: "m1", newModel: "m2", displayName: "模型二", enabled: true });
    const stats = await c.getModelStats("m2");
    await c.deleteModel("m2");

    expect(stats.data.totalPoints).toBe(33);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://b/internal/admin/models/identity",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://b/internal/admin/models/stats?model=m2",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      "http://b/internal/admin/models/delete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("VIP 等级管理接口走内部管理路径", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: 1, name: "普通会员", discountBps: 10000 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: { id: 2, name: "银卡会员", discountBps: 9000 } }), { status: 200 });
    });
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const list = await c.adminListVipLevels();
    const upsert = await c.adminUpsertVipLevel({
      name: "银卡会员",
      sortOrder: 10,
      thresholdRmbFen: 10000,
      discountBps: 9000,
      enabled: true,
      upgradeEnabled: true,
    });
    await c.adminDeleteVipLevel(2);
    expect(list.data[0].name).toBe("普通会员");
    expect(upsert.data.name).toBe("银卡会员");
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://b/internal/admin/vip-levels",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://b/internal/admin/vip-levels",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      "http://b/internal/admin/vip-levels/delete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("upsertModel 和 updateModelDisplay 支持模型广场 metadata", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await c.upsertModel({
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
    await c.updateModelDisplay({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      tags: "chat",
      showInMarketplace: true,
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://b/internal/admin/models",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
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
        }),
      }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://b/internal/admin/models/display",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          model: "glm-4.5",
          displayName: "GLM 4.5",
          enabled: true,
          tags: "chat",
          showInMarketplace: true,
        }),
      }),
    );
  });
});

describe("@ai-assistant/billing 分析方法", () => {
  it("analyticsDaily 返回 data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ date: "2026-06-01", revenueFen: 100, topupCount: 1, grantedPoints: 10, consumedPoints: 5, payingUsers: 1, newPayingUsers: 1 }] }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.analyticsDaily("2026-06-01", "2026-06-02");
    expect(r.data[0].revenueFen).toBe(100);
  });
  it("revenueByUsers 返回映射", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { u1: [{ paidAtDate: "2026-06-01", amountFen: 100, points: 10 }] } }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.revenueByUsers(["u1"]);
    expect(r.data.u1[0].amountFen).toBe(100);
  });
  it("summaryByUsers 返回映射", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { u1: { totalRechargeFen: 1000, totalRechargeOrders: 2, totalConsumptionPoints: 300 } } }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.summaryByUsers(["u1"]);
    expect(r.data.u1.totalRechargeFen).toBe(1000);
    expect(r.data.u1.totalRechargeOrders).toBe(2);
    expect(r.data.u1.totalConsumptionPoints).toBe(300);
  });
});

describe("@ai-assistant/billing 资源价/汇率", () => {
  it("listResourcePrices 返回 data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ resourceKey: "websearch", pricingType: "PER_CALL", rate: 10, perUnits: 1, enabled: true }] }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    expect((await c.listResourcePrices()).data[0].resourceKey).toBe("websearch");
  });
  it("chargeResource 和 refundResource 走内部资源扣费接口", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ charged: 20, success: true }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const charged = await c.chargeResource({ operationId: "image:req1", userId: "u1", resourceKey: "image_generation", units: 2 });
    expect(charged.charged).toBe(20);
    await c.refundResource("image:req1");
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://b/resource/charge",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://b/resource/refund",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("chargeResource 可显式走视频点账户", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ charged: 800 }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await c.chargeResource({
      operationId: "video:req1",
      userId: "u1",
      resourceKey: "video_seedance_2_720p_text",
      units: 8,
      accountType: "video",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/resource/charge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operationId: "video:req1",
          userId: "u1",
          resourceKey: "video_seedance_2_720p_text",
          units: 8,
          accountType: "video",
        }),
      }),
    );
  });
  it("reserveResource 和 settleResource 走内部资源预扣结算接口", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.units === 2000) return new Response(JSON.stringify({ reserved: 4 }), { status: 200 });
      return new Response(JSON.stringify({ settled: 3 }), { status: 200 });
    });
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const reserved = await c.reserveResource({ operationId: "novel:task1", userId: "u1", resourceKey: "novel_text_output", units: 2000 });
    const settled = await c.settleResource({ operationId: "novel:task1", resourceKey: "novel_text_output", units: 1250 });
    expect(reserved.reserved).toBe(4);
    expect(settled.settled).toBe(3);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://b/resource/reserve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://b/resource/settle",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("reserveResource 余额不足抛 InsufficientBalanceError", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: "INSUFFICIENT_BALANCE" }), { status: 402 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    await expect(c.reserveResource({ operationId: "novel:task1", userId: "u1", resourceKey: "novel_text_output", units: 2000 }))
      .rejects.toBeInstanceOf(InsufficientBalanceError);
  });
  it("getRechargeRatio 返回 ratio", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ratio: 100 }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    expect((await c.getRechargeRatio()).ratio).toBe(100);
  });
  it("listAdminOrders 拼接筛选参数并返回订单汇总", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 1, tradeNo: "ai1", userId: "u1", amountFen: 100, points: 700, provider: "epay", paymentMethod: "alipay", status: "success", kind: "points", cardId: 0, createdAt: "2026-07-02T08:16:00Z", paidAt: "2026-07-02T08:16:10Z" }],
      total: 1,
      summary: { total: 1, successCount: 1, pendingCount: 0, closedCount: 0, successAmountFen: 100, successPoints: 700, payingUsers: 1 },
    }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.listAdminOrders({ userIds: ["u1", "u2"], status: "success", kind: "points", limit: 50, offset: 0 });
    expect(r.summary.successAmountFen).toBe(100);
    expect(r.data[0].tradeNo).toBe("ai1");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/internal/admin/orders?userIds=u1%2Cu2&status=success&kind=points&limit=50",
      expect.objectContaining({ method: "GET" }),
    );
  });
  it("充值套餐读写接口返回 data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "standard", name: "标准包", amountFen: 7900, points: 5000, enabled: true, sortOrder: 20 }],
      success: true,
    }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    expect((await c.listRechargePackages()).data[0].id).toBe("standard");
    expect((await c.adminListRechargePackages()).data[0].points).toBe(5000);
    await c.setRechargePackages([{ id: "standard", name: "标准包", amountFen: 7900, points: 5000, enabled: true, sortOrder: 20 }]);
    expect(fetchFn).toHaveBeenLastCalledWith(
      "http://b/internal/admin/config/recharge-packages",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("@ai-assistant/billing 月卡管理", () => {
  it("listMembershipCards 返回 data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 1, name: "月卡", priceFen: 30000, durationDays: 30, cadence: "DAILY", grantPoints: 1000, enabled: true, createdAt: "2026-06-28T10:00:00Z", updatedAt: "2026-06-28T10:00:00Z" }]
    }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.listMembershipCards();
    expect(r.data[0].name).toBe("月卡");
    expect(r.data[0].priceFen).toBe(30000);
  });
  it("buyMembership 返回 payUrl 和 tradeNo", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ payUrl: "http://epay.url", tradeNo: "mem123" }), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn });
    const r = await c.buyMembership("u1", 1, "wxpay");
    expect(r.payUrl).toBe("http://epay.url");
    expect(r.tradeNo).toBe("mem123");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://b/membership/buy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "u1", cardId: 1, method: "wxpay" }),
      }),
    );
  });
});

// 「有真实用量却结算到 0 点」= 预留已被兜底提前关账（wallet.Settle 对非 reserved 记录
// 静默 return nil）。以前这类漏计费全程无人报错，哨兵负责让它必然自报。
describe("结算静默归零哨兵", () => {
  const settleReceipt = (settled: number) =>
    vi.fn(async () => new Response(JSON.stringify({ settled }), { status: 200 }));

  it("settleResource 有量结算到 0 点时上报，且不改变返回值", async () => {
    const onSilentSettlement = vi.fn();
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(0), onSilentSettlement });
    const r = await c.settleResource({
      operationId: "codex-pet:run:run-1:planned-images",
      resourceKey: "image_generation_2k",
      units: 8,
    });
    expect(r.settled).toBe(0);
    expect(onSilentSettlement).toHaveBeenCalledTimes(1);
    expect(onSilentSettlement).toHaveBeenCalledWith({
      kind: "resource",
      operationId: "codex-pet:run:run-1:planned-images",
      resourceKey: "image_generation_2k",
      units: 8,
      settled: 0,
    });
  });

  it("正常结算不上报", async () => {
    const onSilentSettlement = vi.fn();
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(1600), onSilentSettlement });
    await c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 8 });
    expect(onSilentSettlement).not.toHaveBeenCalled();
  });

  // 桌宠失败宽限路径就是这个形状：一次都没交付，结算 0 点是正确结果，不该报警。
  it("零用量结算 0 点不上报", async () => {
    const onSilentSettlement = vi.fn();
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(0), onSilentSettlement });
    await c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 0 });
    expect(onSilentSettlement).not.toHaveBeenCalled();
  });

  // 幂等重放：resource.Settle 回读记录里的 actual_points，所以重复结算拿到的是原值，
  // 不会因为「这次没扣钱」而变成噪声。
  it("幂等重放拿到已记账点数不上报", async () => {
    const onSilentSettlement = vi.fn();
    const fetchFn = settleReceipt(1600);
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn, onSilentSettlement });
    await c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 8 });
    await c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 8 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onSilentSettlement).not.toHaveBeenCalled();
  });

  it("视频结算只有输入用量时也算真实用量", async () => {
    const onSilentSettlement = vi.fn();
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(0), onSilentSettlement });
    await c.settleVideoResource({ operationId: "dub:1", resourceKey: "video_io", units: 0, inputUnits: 12 });
    expect(onSilentSettlement).toHaveBeenCalledWith({
      kind: "video",
      operationId: "dub:1",
      resourceKey: "video_io",
      units: 0,
      inputUnits: 12,
      settled: 0,
    });
  });

  it("响应缺 settled 字段按静默归零处理", async () => {
    const onSilentSettlement = vi.fn();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn, onSilentSettlement });
    await c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 3 });
    expect(onSilentSettlement).toHaveBeenCalledWith(expect.objectContaining({ units: 3, settled: undefined }));
  });

  // 哨兵是旁路观测，落点自己炸了也不能把一笔已经成功的结算变成失败——那会让调用方
  // 去退款或重试，比漏计费更糟。
  it("上报落点抛错不影响结算结果", async () => {
    const onSilentSettlement = vi.fn(() => {
      throw new Error("logger down");
    });
    const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(0), onSilentSettlement });
    await expect(c.settleResource({ operationId: "op", resourceKey: "image_generation_2k", units: 8 }))
      .resolves.toEqual({ settled: 0 });
    expect(onSilentSettlement).toHaveBeenCalledTimes(1);
  });

  it("未传落点时默认写 console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const c = createBillingClient({ baseUrl: "http://b", token: "t", fetchFn: settleReceipt(0) });
      await c.settleResource({ operationId: "op-warn", resourceKey: "image_generation_2k", units: 8 });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("结算静默归零");
      expect(line).toContain("op-warn");
      expect(line).toContain("8 单位真实用量只结算到 0 点");
    } finally {
      warn.mockRestore();
    }
  });

  it("isSilentSettlement 判据只看有量没钱", () => {
    expect(isSilentSettlement({ units: 8, settled: 0 })).toBe(true);
    expect(isSilentSettlement({ units: 0, settled: 0 })).toBe(false);
    expect(isSilentSettlement({ units: 8, settled: 1600 })).toBe(false);
    expect(isSilentSettlement({ units: 8, settled: Number.NaN })).toBe(true);
    expect(isSilentSettlement({ units: 8, settled: -1 })).toBe(true);
    expect(isSilentSettlement({ units: 0, inputUnits: 5, settled: 0 })).toBe(true);
  });
});
