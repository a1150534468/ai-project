import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { createAdmin } from "./service.js";
import { signAdminToken } from "./token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let token = "";
let noPermToken = "";
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
    permissions: ["ANNOUNCEMENT_MANAGE"],
  });
  noPermToken = signAdminToken(a2.id, process.env.ADMIN_SESSION_SECRET!);
  createdAdminIds.push(a2.id);

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

  it("搜索不区分大小写", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/users?q=BYADM_",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.length).toBeGreaterThan(0);
  });

  it("列表分页返回 total/page/pageSize", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/users?page=1&pageSize=1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThan(0);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(1);

    // 第二页与第一页内容不同（库里至少有两个用户）
    if (body.total > 1) {
      const r2 = await app.inject({
        method: "GET",
        url: "/api/admin/users?page=2&pageSize=1",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().data[0]?.id).not.toBe(body.data[0]?.id);
    }

    // 非法分页参数回退默认值
    const r3 = await app.inject({
      method: "GET",
      url: "/api/admin/users?page=-1&pageSize=9999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().page).toBe(1);
    expect(r3.json().pageSize).toBe(100);

    // 超大 page 数字串不会因 skip 溢出 Int64 而 500
    const r4 = await app.inject({
      method: "GET",
      url: "/api/admin/users?page=99999999999999999999999&pageSize=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().page).toBe(1_000_000);
    expect(r4.json().data).toEqual([]);
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
  });
});

function uniqueUid(): string {
  return String(Math.floor(10_000_000 + Math.random() * 90_000_000));
}
