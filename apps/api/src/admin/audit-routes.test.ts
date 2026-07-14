import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let superToken = "";
let plainToken = "";
const createdAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  const secret = process.env.ADMIN_SESSION_SECRET!;
  const s = await createAdmin(prisma, { username: `auditsuper_${Date.now()}`, password: "password123", role: "super_admin", permissions: [] });
  createdAdminIds.push(s.id);
  superToken = signAdminToken(s.id, secret);
  const p = await createAdmin(prisma, { username: `auditplain_${Date.now()}`, password: "password123", role: "admin", permissions: ["USER_MANAGE"] });
  createdAdminIds.push(p.id);
  plainToken = signAdminToken(p.id, secret);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("admin 审计列表", () => {
  it("非 ADMIN_MANAGE（普通 admin）403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/audit", headers: { authorization: `Bearer ${plainToken}` } });
    expect(r.statusCode).toBe(403);
  });
  it("超管可读，返回数组", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/audit?limit=10", headers: { authorization: `Bearer ${superToken}` } });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json().data)).toBe(true);
  });
});
