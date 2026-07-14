import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let token = "";
let noPermToken = "";
const createdAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1"; // 不可达以跳过 billing 测试
  process.env.BILLING_INTERNAL_TOKEN ??= "internal-token";

  const secret = process.env.ADMIN_SESSION_SECRET!;
  const a = await createAdmin(prisma, {
    username: `codeadm_${Date.now()}`,
    password: "password123",
    role: "super_admin",
    permissions: [],
  });
  createdAdminIds.push(a.id);
  token = signAdminToken(a.id, secret);

  const b = await createAdmin(prisma, {
    username: `noperm_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["USER_MANAGE"],
  });
  createdAdminIds.push(b.id);
  noPermToken = signAdminToken(b.id, secret);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("admin 兑换码路由", () => {
  it("无 REDEMPTION_MANAGE 403", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${noPermToken}` },
      payload: { grantType: "BALANCE", grantPayload: '{"points":10}', count: 1 },
    });
    expect(r.statusCode).toBe(403);
  });

  it("参数不合法 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "BALANCE", count: 0 }, // count 不合法
    });
    expect(r.statusCode).toBe(400);
  });

  it("grantPayload 非 JSON 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "BALANCE", grantPayload: "not-json", count: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("JSON");
  });

  it("BALANCE 缺少 points 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "BALANCE", grantPayload: '{"other":1}', count: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("points");
  });

  it("BALANCE points 不是正整数 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "BALANCE", grantPayload: '{"points":0}', count: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("正整数");
  });

  it("MEMBERSHIP 缺少 tier 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "MEMBERSHIP", grantPayload: '{"days":30}', count: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("tier");
  });

  it("MEMBERSHIP days 不是正整数 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "MEMBERSHIP", grantPayload: '{"tier":"pro","days":-1}', count: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("days");
  });

  it("FEATURE/PACKAGE grantPayload 通过校验不报错", async () => {
    // 这里不会调 billing（IP 不可达），预期 502
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/codes",
      headers: { authorization: `Bearer ${token}` },
      payload: { grantType: "FEATURE", grantPayload: '{"key":"x"}', count: 1 },
    });
    // payload 校验通过，但 billing 不可达
    expect(r.statusCode).toBe(502);
  });
});
