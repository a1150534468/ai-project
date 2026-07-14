import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { createAdmin } from "./service.js";
import { signAdminToken } from "./token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let token = "";
let noPermToken = "";
let billingLogToken = "";
let detailToken = "";
const createdAdminIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);

  // admin with USER_MANAGE
  const n = `adm_u_${Date.now()}`;
  const a = await createAdmin(prisma, {
    username: n,
    password: "pw12345678",
    role: "admin",
    permissions: ["USER_MANAGE"],
  });
  token = signAdminToken(a.id, process.env.ADMIN_SESSION_SECRET!);
  createdAdminIds.push(a.id);

  // admin without USER_MANAGE (for permission tests)
  const n2 = `adm_np_${Date.now()}`;
  const a2 = await createAdmin(prisma, {
    username: n2,
    password: "pw12345678",
    role: "admin",
    permissions: ["VIEW_ANALYTICS"],
  });
  noPermToken = signAdminToken(a2.id, process.env.ADMIN_SESSION_SECRET!);
  createdAdminIds.push(a2.id);

  const billingAdmin = await createAdmin(prisma, {
    username: `adm_bill_${Date.now()}`,
    password: "pw12345678",
    role: "admin",
    permissions: ["USER_BILLING_LOG_VIEW"],
  });
  billingLogToken = signAdminToken(billingAdmin.id, process.env.ADMIN_SESSION_SECRET!);
  createdAdminIds.push(billingAdmin.id);

  const detailAdmin = await createAdmin(prisma, {
    username: `adm_detail_${Date.now()}`,
    password: "pw12345678",
    role: "admin",
    permissions: ["USER_DETAIL_VIEW"],
  });
  detailToken = signAdminToken(detailAdmin.id, process.env.ADMIN_SESSION_SECRET!);
  createdAdminIds.push(detailAdmin.id);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: "byadm_" } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("admin 用户管理", () => {
  let userId = "";

  it("创建用户返回 uid", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `byadm_${Date.now()}`, password: "pw12345678" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.uid).toMatch(/^[1-9]\d{7}$/);
    userId = r.json().data.id;
  });

  it("列表能搜到", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/users?q=byadm_",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.length).toBeGreaterThan(0);
  });

  it("封禁/解封", async () => {
    const ban = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/ban`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ban.statusCode).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.bannedAt).not.toBeNull();

    const un = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/unban`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(un.statusCode).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.bannedAt).toBeNull();
  });

  it("无 USER_MANAGE 权限的管理员被拒（403）", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${noPermToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("USER_MANAGE 不可查看完整用户详情", async () => {
    const user = await prisma.user.create({
      data: { uid: uniqueUid(), username: `byadm_detail_${Date.now()}`, passwordHash: "x" },
    });
    createdUserIds.push(user.id);
    const r = await app.inject({
      method: "GET",
      url: `/api/admin/users/${user.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("扣费日志权限只能查看单用户扣费日志", async () => {
    const user = await prisma.user.create({
      data: { uid: uniqueUid(), username: `byadm_bill_${Date.now()}`, passwordHash: "x" },
    });
    createdUserIds.push(user.id);
    const billing = await app.inject({
      method: "GET",
      url: `/api/admin/users/${user.id}/billing-log`,
      headers: { authorization: `Bearer ${billingLogToken}` },
    });
    expect(billing.statusCode).toBe(200);
    expect(Array.isArray(billing.json().data.consumptionRecords)).toBe(true);
    expect(billing.json().data.kpis).toBeUndefined();
    expect(billing.json().data.timeline).toBeUndefined();

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/users/${user.id}/detail`,
      headers: { authorization: `Bearer ${billingLogToken}` },
    });
    expect(detail.statusCode).toBe(403);
  });

  it("完整详情权限可以查看完整用户详情", async () => {
    const user = await prisma.user.create({
      data: { uid: uniqueUid(), username: `byadm_full_${Date.now()}`, passwordHash: "x" },
    });
    createdUserIds.push(user.id);
    const r = await app.inject({
      method: "GET",
      url: `/api/admin/users/${user.id}/detail`,
      headers: { authorization: `Bearer ${detailToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.kpis).toBeDefined();
    expect(Array.isArray(r.json().data.timeline)).toBe(true);
    expect(Array.isArray(r.json().data.consumptionRecords)).toBe(true);
  });
});

describe("admin 设备管理", () => {
  it("无 USER_MANAGE 吊销设备 403", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/devices/x/revoke",
      headers: { authorization: `Bearer ${noPermToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("吊销不存在设备 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/devices/nonexistent/revoke",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(404);
  });

  it("列某用户设备返回数组", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/users/someuser/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json().data)).toBe(true);
  });
});

function uniqueUid(): string {
  return String(Math.floor(10_000_000 + Math.random() * 90_000_000));
}
