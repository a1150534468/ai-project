import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// billing 服务未起：打桩 createBillingClient，summaryByUsers 返回可控数据
vi.mock("@yc/billing", async (orig) => {
  const actual = await orig<typeof import("@yc/billing")>();
  return {
    ...actual,
    createBillingClient: () => ({
      summaryByUsers: async (ids: string[]) => ({
        data: Object.fromEntries(
          ids.map((id) => [id, { totalRechargeFen: 1000, totalRechargeOrders: 1, totalConsumptionPoints: 0 }]),
        ),
      }),
    }),
  };
});

import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { createAdmin } from "./service.js";
import { signAdminToken } from "./token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let superTok = ""; // super_admin
let plainTok = ""; // 无 RESELLER_MANAGE 的普通 admin
const admIds: string[] = [];
const createdCodes = ["RA", "RB", "RC"];
const createdResellerUsernames = ["res_t8_a", "res_t8_b", "res_t8_dup"];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:8093";
  process.env.BILLING_INTERNAL_TOKEN ??= "test-token";
  const secret = process.env.ADMIN_SESSION_SECRET!;
  // 建前清残留（前次运行若中断可能留下固定渠道码/用户名，避免唯一约束冲突）
  await prisma.user.deleteMany({ where: { username: { startsWith: "u_t8_" } } });
  await prisma.channel.deleteMany({ where: { code: { in: createdCodes } } });
  await prisma.admin.deleteMany({ where: { username: { in: [...createdResellerUsernames, "res_t8_c"] } } });
  const sup = await createAdmin(prisma, {
    username: `adm_t8_sup_${Date.now()}`,
    password: "pw12345678",
    role: "super_admin",
    permissions: [],
  });
  const plain = await createAdmin(prisma, {
    username: `adm_t8_plain_${Date.now()}`,
    password: "pw12345678",
    role: "admin",
    permissions: ["ANNOUNCEMENT_MANAGE"],
  });
  admIds.push(sup.id, plain.id);
  superTok = signAdminToken(sup.id, secret);
  plainTok = signAdminToken(plain.id, secret);
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  // 清理：先删 user，再删 channel，最后删 admin（含被建的 reseller admin）
  await prisma.user.deleteMany({ where: { username: { startsWith: "u_t8_" } } });
  await prisma.channel.deleteMany({ where: { code: { in: createdCodes } } });
  await prisma.admin.deleteMany({ where: { username: { in: createdResellerUsernames } } });
  await prisma.admin.deleteMany({ where: { id: { in: admIds } } });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("总台代理专栏", () => {
  it("无 RESELLER_MANAGE 的普通 admin → 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/resellers", headers: auth(plainTok) });
    expect(r.statusCode).toBe(403);
  });

  it("super_admin 建代理 → 200 返回 code", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resellers",
      headers: auth(superTok),
      payload: { username: "res_t8_a", password: "password123", code: "RA", commissionRate: 0.1 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ success: boolean; data: { channel: { code: string } } }>().data.channel.code).toBe("RA");
  });

  it("撞已存在渠道码 → 409", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resellers",
      headers: auth(superTok),
      payload: { username: "res_t8_dup", password: "password123", code: "RA", commissionRate: 0.1 },
    });
    expect(r.statusCode).toBe(409);
  });

  it("改分成比例 → 200 且更新", async () => {
    // 先建一个
    const c = await app.inject({
      method: "POST",
      url: "/api/admin/resellers",
      headers: auth(superTok),
      payload: { username: "res_t8_b", password: "password123", code: "RB", commissionRate: 0.1 },
    });
    const channelId = c.json<{ success: boolean; data: { channel: { id: string } } }>().data.channel.id;
    const r = await app.inject({
      method: "PATCH",
      url: `/api/admin/resellers/${channelId}`,
      headers: auth(superTok),
      payload: { commissionRate: 0.3, enabled: false },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ success: boolean; data: { commissionRate: number; enabled: boolean } }>().data.commissionRate).toBeCloseTo(0.3);
    expect(r.json<{ success: boolean; data: { commissionRate: number; enabled: boolean } }>().data.enabled).toBe(false);
  });

  it("改不存在的渠道 → 404", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: "/api/admin/resellers/nonexistent_id",
      headers: auth(superTok),
      payload: { commissionRate: 0.2 },
    });
    expect(r.statusCode).toBe(404);
  });

  it("列表返回含 code/rate/enabled/username", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/resellers", headers: auth(superTok) });
    expect(r.statusCode).toBe(200);
    const row = r.json<{ success: boolean; data: Array<{ code: string; username: string; commissionRate: number; enabled: boolean }> }>().data.find((x) => x.code === "RA");
    expect(row).toBeTruthy();
    expect(row?.username).toBe("res_t8_a");
    expect(typeof row?.commissionRate).toBe("number");
  });

  it("某代理汇总 → 200 含 totalUsers/commissionFen（billing 打桩）", async () => {
    // 建 RC 渠道 + 挂一个用户，验证 commissionFen = 充值×比例
    const c = await app.inject({
      method: "POST",
      url: "/api/admin/resellers",
      headers: auth(superTok),
      payload: { username: "res_t8_c", password: "password123", code: "RC", commissionRate: 0.1 },
    });
    createdResellerUsernames.push("res_t8_c");
    const channelId = c.json<{ success: boolean; data: { channel: { id: string } } }>().data.channel.id;
    // 挂一个用户到该渠道
    const u = await prisma.user.create({
      data: { uid: "RC-00000001", username: "u_t8_rc", passwordHash: "x", channelId },
    });
    const r = await app.inject({
      method: "GET",
      url: `/api/admin/resellers/${channelId}/summary`,
      headers: auth(superTok),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ success: boolean; data: { totalUsers: number; commissionFen: number } }>().data.totalUsers).toBe(1);
    expect(r.json<{ success: boolean; data: { totalUsers: number; commissionFen: number } }>().data.commissionFen).toBe(100); // 桩:充值1000分 ×0.1 = 100
    await prisma.user.delete({ where: { id: u.id } });
  });

  it("可见项 GET/PUT", async () => {
    const g = await app.inject({ method: "GET", url: "/api/admin/reseller-visibility", headers: auth(superTok) });
    expect(g.statusCode).toBe(200);
    expect(g.json<{ success: boolean; data: { showRecharge: boolean } }>().data.showRecharge).toBe(true);
    const p = await app.inject({
      method: "PUT",
      url: "/api/admin/reseller-visibility",
      headers: auth(superTok),
      payload: { showConsumption: false },
    });
    expect(p.statusCode).toBe(200);
    expect(p.json<{ success: boolean; data: { showConsumption: boolean } }>().data.showConsumption).toBe(false);
    // 复原
    await app.inject({
      method: "PUT",
      url: "/api/admin/reseller-visibility",
      headers: auth(superTok),
      payload: { showConsumption: true },
    });
  });
});
