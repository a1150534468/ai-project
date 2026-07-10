import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let analyticsAdmin = "";
let otherAdmin = "";
let kbAdmin = "";
const createdAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.EMBEDDING_MODEL ??= "test-embedding-model";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1";
  process.env.BILLING_INTERNAL_TOKEN ??= "t";
  // 故意不设 SKYHUMAN_API_TOKEN：授权用户仍应通过鉴权门，但因飞天未配置而得 502（不发真实网络请求）

  const secret = process.env.ADMIN_SESSION_SECRET!;
  const a = await createAdmin(prisma, { username: `dubadm_${Date.now()}`, password: "password123", role: "admin", permissions: ["VIEW_ANALYTICS"] });
  createdAdminIds.push(a.id);
  analyticsAdmin = signAdminToken(a.id, secret);

  const b = await createAdmin(prisma, { username: `dubother_${Date.now()}`, password: "password123", role: "admin", permissions: ["MODEL_MANAGE"] });
  createdAdminIds.push(b.id);
  otherAdmin = signAdminToken(b.id, secret);

  const c = await createAdmin(prisma, { username: `dubkb_${Date.now()}`, password: "password123", role: "admin", permissions: ["KNOWLEDGE_MANAGE"] });
  createdAdminIds.push(c.id);
  kbAdmin = signAdminToken(c.id, secret);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("admin 飞天余额路由", () => {
  it("无 VIEW_ANALYTICS 权限 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/dub/skyhuman/credit", headers: { authorization: `Bearer ${otherAdmin}` } });
    expect(r.statusCode).toBe(403);
  });

  it("有权限但飞天未配置 502（鉴权通过）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/dub/skyhuman/credit", headers: { authorization: `Bearer ${analyticsAdmin}` } });
    expect(r.statusCode).toBe(502);
  });
});

describe("admin BGM 预制管理", () => {
  it("无 KNOWLEDGE_MANAGE 权限 GET 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/dub/bgm", headers: { authorization: `Bearer ${otherAdmin}` } });
    expect(r.statusCode).toBe(403);
  });
  it("有 KNOWLEDGE_MANAGE 权限 GET 200 返回列表", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/dub/bgm", headers: { authorization: `Bearer ${kbAdmin}` } });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray((r.json() as { data: unknown[] }).data)).toBe(true);
  });
  it("无权限 DELETE 403", async () => {
    const r = await app.inject({ method: "DELETE", url: "/api/admin/dub/bgm/x", headers: { authorization: `Bearer ${otherAdmin}` } });
    expect(r.statusCode).toBe(403);
  });
  it("有权限 DELETE 不存在的 BGM 404", async () => {
    const r = await app.inject({ method: "DELETE", url: "/api/admin/dub/bgm/nope", headers: { authorization: `Bearer ${kbAdmin}` } });
    expect(r.statusCode).toBe(404);
  });
});
