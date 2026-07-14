import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@ai-assistant/billing", async (orig) => {
  const actual = await orig<typeof import("@ai-assistant/billing")>();
  return {
    ...actual,
    createBillingClient: () => ({
      summaryByUsers: async (ids: string[]) => ({
        data: Object.fromEntries(
          ids.map((id) => [id, { totalRechargeFen: 1000, totalRechargeOrders: 1, totalConsumptionPoints: 50 }]),
        ),
      }),
    }),
  };
});

// 可见项是 id="singleton" 的全局单行配置，service.test.ts 也在并发改它。
// 这里改成注入本文件独占的可见项，避免跨文件抢同一行（DB 读写由 service.test.ts 覆盖）。
const vis = vi.hoisted(() => ({
  showRecharge: true,
  showConsumption: true,
  showMembership: true,
  showLastActive: true,
}));

vi.mock("./service.js", async (orig) => {
  const actual = await orig<typeof import("./service.js")>();
  return { ...actual, getVisibilityConfig: async () => vis };
});

import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { createAdmin } from "../admin/service.js";
import { signAdminToken } from "../admin/token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let resTokA = "";
let resTokB = "";
let plainTok = "";
const cleanupUserIds: string[] = [];
const cleanupChannelCodes = ["RX", "RY"];
const cleanupAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  const secret = process.env.ADMIN_SESSION_SECRET!;

  // 建前清残留（前次运行若中断可能留下固定 uid/渠道码，避免唯一约束冲突）
  await prisma.user.deleteMany({ where: { uid: { in: ["RX-00000001", "RX-00000002", "RY-00000001"] } } });
  await prisma.channel.deleteMany({ where: { code: { in: cleanupChannelCodes } } });

  // 代理 A + 渠道 RX + 2 个用户
  const admA = await createAdmin(prisma, { username: `res_t9_a_${Date.now()}`, password: "pw12345678", role: "reseller", permissions: [] });
  const chA = await prisma.channel.create({ data: { code: "RX", ownerType: "RESELLER", resellerId: admA.id, commissionRate: 0.1, enabled: true } });
  // 用户名不能落在 "u_" 前缀里：其它测试文件按前缀清库时会顺手删掉，导致本文件的人数断言归零
  const u1 = await prisma.user.create({ data: { uid: "RX-00000001", username: `res_t9_rx1_${Date.now()}`, passwordHash: "x", channelId: chA.id } });
  const u2 = await prisma.user.create({ data: { uid: "RX-00000002", username: `res_t9_rx2_${Date.now()}`, passwordHash: "x", channelId: chA.id } });

  // 代理 B + 渠道 RY + 1 个用户（用于越权隔离验证）
  const admB = await createAdmin(prisma, { username: `res_t9_b_${Date.now()}`, password: "pw12345678", role: "reseller", permissions: [] });
  const chB = await prisma.channel.create({ data: { code: "RY", ownerType: "RESELLER", resellerId: admB.id, commissionRate: 0.2, enabled: true } });
  const u3 = await prisma.user.create({ data: { uid: "RY-00000001", username: `res_t9_ry1_${Date.now()}`, passwordHash: "x", channelId: chB.id } });

  // 一个普通 admin（非 reseller）
  const plain = await createAdmin(prisma, { username: `adm_t9_plain_${Date.now()}`, password: "pw12345678", role: "admin", permissions: [] });

  cleanupUserIds.push(u1.id, u2.id, u3.id);
  cleanupAdminIds.push(admA.id, admB.id, plain.id);
  resTokA = signAdminToken(admA.id, secret);
  resTokB = signAdminToken(admB.id, secret);
  plainTok = signAdminToken(plain.id, secret);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.channel.deleteMany({ where: { code: { in: cleanupChannelCodes } } });
  await prisma.admin.deleteMany({ where: { id: { in: cleanupAdminIds } } });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe("代理自助 /api/reseller", () => {
  it("非代理（普通 admin）→ /summary 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/reseller/summary", headers: auth(plainTok) });
    expect(r.statusCode).toBe(403);
  });

  it("代理 A 看自己渠道汇总：totalUsers=2, commissionFen=200", async () => {
    const r = await app.inject({ method: "GET", url: "/api/reseller/summary", headers: auth(resTokA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.totalUsers).toBe(2);
    expect(r.json().data.commissionFen).toBe(200); // 2×1000×0.1
  });

  it("代理 A 用户列表只含自己渠道的用户（不含 B 的）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/reseller/users", headers: auth(resTokA) });
    expect(r.statusCode).toBe(200);
    const rows = r.json().data.rows;
    expect(r.json().data.total).toBe(2);
    const uids = rows.map((x: any) => x.uid);
    expect(uids).toContain("RX-00000001");
    expect(uids).not.toContain("RY-00000001"); // 越权隔离：看不到 B 的用户
  });

  it("代理 B 只看到自己的 1 个用户（隔离对称）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/reseller/users", headers: auth(resTokB) });
    expect(r.json().data.total).toBe(1);
    expect(r.json().data.rows[0].uid).toBe("RY-00000001");
  });

  it("关闭 showConsumption 后用户行无 totalConsumptionPoints", async () => {
    vis.showConsumption = false;
    const r = await app.inject({ method: "GET", url: "/api/reseller/users", headers: auth(resTokA) });
    expect(r.json().data.rows[0]).not.toHaveProperty("totalConsumptionPoints");
    vis.showConsumption = true; // 复原
  });
});
