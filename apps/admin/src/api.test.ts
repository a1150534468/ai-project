import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "./api.js";
import { saveSession, clearSession } from "./auth.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  clearSession();
  // jsdom 提供 sessionStorage；vitest 默认 node 环境需在 config 指定 jsdom（见 Task 9 注）
});

describe("admin api 客户端", () => {
  it("login 成功返回 session 字段", async () => {
    globalThis.fetch = mockFetch(200, { token: "tk", adminId: "a1", role: "admin", permissions: ["USER_MANAGE"] });
    const s = await api.login("u", "p");
    expect(s.token).toBe("tk");
    expect(s.permissions).toEqual(["USER_MANAGE"]);
  });
  it("401 抛 UnauthorizedError", async () => {
    saveSession({ token: "tk", adminId: "a", role: "admin", permissions: [] });
    globalThis.fetch = mockFetch(401, { error: "x" });
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.UnauthorizedError);
  });
  it("403 抛 ForbiddenError", async () => {
    saveSession({ token: "tk", adminId: "a", role: "admin", permissions: [] });
    globalThis.fetch = mockFetch(403, { error: "no perm" });
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.ForbiddenError);
  });

  it("VIP 等级接口和模型 metadata 字段会正确透传", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.includes("/api/admin/vip-levels") && init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 1, name: "普通会员", discountBps: 10000 }] }),
        } as Response;
      }
      if (url.includes("/api/admin/users/u1/detail")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              user: { id: "u1", uid: "10000001", username: "alice", bannedAt: null, createdAt: "2026-07-01T00:00:00Z" },
              kpis: {
                onlineToday: false,
                onlineDevices: 0,
                loginCountToday: 0,
                todayToken: 0,
                todayAgent: 0,
                totalToken: 0,
                todayRechargeYuan: 0,
                todayConsumptionPoints: 0,
                totalRechargeYuan: 0,
                totalConsumptionPoints: 0,
                balance: 10,
                currentMemberships: [],
              },
              vipSummary: {
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
              activity: [],
              devices: [],
              consumptionRecords: [{
                operationId: "op1",
                type: "chat",
                model: "glm-4.5",
                displayName: "GLM 4.5",
                status: "settled",
                reservedPoints: 120,
                actualPoints: 90,
                originalPoints: 100,
                vipLevelName: "银卡会员",
                vipDiscountBps: 9000,
                vipSavedPoints: 10,
                vipGrowthPoints: 90,
                inputTokens: 1,
                outputTokens: 2,
                cacheInputTokens: 0,
                cacheOutputTokens: 0,
                createdAt: "2026-07-01T00:00:00Z",
                settledAt: "2026-07-01T00:01:00Z",
              }],
              rechargeEvents: [],
              timeline: [],
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { id: 2, name: "银卡会员", discountBps: 9000 } }),
      } as Response;
    }) as typeof fetch;

    await api.listVipLevels();
    await api.upsertVipLevel({
      name: "银卡会员",
      sortOrder: 10,
      thresholdRmbFen: 10000,
      discountBps: 9000,
      enabled: true,
      upgradeEnabled: true,
    });
    await api.deleteVipLevel(2);
    await api.upsertModel({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      inputPriceRmbPerMillion: 1,
      outputPriceRmbPerMillion: 2,
      cacheInputPriceRmbPerMillion: 0.5,
      cacheOutputPriceRmbPerMillion: 0.8,
      description: "适合聊天",
      tags: "chat,reasoning",
      contextLength: 128000,
      useCases: "客服",
      sortOrder: 10,
      showInMarketplace: true,
    });
    await api.updateModelDisplay("glm-4.5", "GLM 4.5", true, {
      tags: "chat",
      showInMarketplace: true,
    });
    const detail = await api.getUserDetail("u1");

    expect(calls[0]?.input).toBe("/api/admin/vip-levels");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({
      name: "银卡会员",
      sortOrder: 10,
      thresholdRmbFen: 10000,
      discountBps: 9000,
      enabled: true,
      upgradeEnabled: true,
    }));
    expect(calls[3]?.init?.body).toBe(JSON.stringify({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      inputPriceRmbPerMillion: 1,
      outputPriceRmbPerMillion: 2,
      cacheInputPriceRmbPerMillion: 0.5,
      cacheOutputPriceRmbPerMillion: 0.8,
      description: "适合聊天",
      tags: "chat,reasoning",
      contextLength: 128000,
      useCases: "客服",
      sortOrder: 10,
      showInMarketplace: true,
    }));
    expect(calls[4]?.init?.body).toBe(JSON.stringify({
      model: "glm-4.5",
      displayName: "GLM 4.5",
      enabled: true,
      tags: "chat",
      showInMarketplace: true,
    }));
    expect(detail.vipSummary).not.toBeNull();
    expect(detail.vipSummary?.levelName).toBe("银卡会员");
    expect(detail.consumptionRecords[0]?.originalPoints).toBe(100);
    expect(detail.consumptionRecords[0]?.vipGrowthPoints).toBe(90);
  });
});
