import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let viewer = "";
let noPerm = "";
const createdAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1";
  process.env.BILLING_INTERNAL_TOKEN ??= "t";
  const secret = process.env.ADMIN_SESSION_SECRET!;
  const a = await createAdmin(prisma, { username: `ana_${Date.now()}`, password: "password123", role: "admin", permissions: ["VIEW_ANALYTICS"] });
  createdAdminIds.push(a.id);
  viewer = signAdminToken(a.id, secret);
  const b = await createAdmin(prisma, { username: `anano_${Date.now()}`, password: "password123", role: "admin", permissions: ["USER_MANAGE"] });
  createdAdminIds.push(b.id);
  noPerm = signAdminToken(b.id, secret);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("BI 大盘端点", () => {
  it("无 VIEW_ANALYTICS 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/analytics/overview", headers: { authorization: `Bearer ${noPerm}` } });
    expect(r.statusCode).toBe(403);
  });
  it("overview 有权限可读（空数据返回 data:null）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/analytics/overview", headers: { authorization: `Bearer ${viewer}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty("success", true);
  });
  it("daily 返回数组", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/analytics/daily?days=7", headers: { authorization: `Bearer ${viewer}` } });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json().data)).toBe(true);
  });
  it("rebuild from>to 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/analytics/rebuild", headers: { authorization: `Bearer ${viewer}` }, payload: { from: "2026-06-10", to: "2026-06-01" } });
    expect(r.statusCode).toBe(400);
  });
});
