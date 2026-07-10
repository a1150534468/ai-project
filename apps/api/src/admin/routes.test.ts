import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { createAdmin } from "./service.js";
import { signAdminToken } from "./token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let superTok = "", superId = "";
const names: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  const sname = `adm_s_${Date.now()}`; names.push(sname);
  const s = await createAdmin(prisma, { username: sname, password: "pw12345678", role: "super_admin", permissions: [] });
  superId = s.id;
  superTok = signAdminToken(superId, process.env.ADMIN_SESSION_SECRET!);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.admin.deleteMany({ where: { username: { in: names } } });
  await prisma.admin.deleteMany({ where: { createdBy: superId } });
});

describe("admin 路由", () => {
  it("登录成功返回 token", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: names[0], password: "pw12345678" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();
  });
  it("登录密码错 401", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: names[0], password: "wrong" } });
    expect(r.statusCode).toBe(401);
  });
  it("超管建管理员并授权", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/admin/admins",
      headers: { authorization: `Bearer ${superTok}` },
      payload: { username: `adm_c_${Date.now()}`, password: "pw12345678", permissions: ["USER_MANAGE"] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.role).toBe("admin");
  });
  it("无 token 建管理员 401", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/admins", payload: { username: "x", password: "pw12345678", permissions: [] } });
    expect(r.statusCode).toBe(401);
  });
  it("禁止把 ADMIN_MANAGE 授予普通管理员（防提权）", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/admin/admins",
      headers: { authorization: `Bearer ${superTok}` },
      payload: { username: `adm_esc_${Date.now()}`, password: "pw12345678", permissions: ["ADMIN_MANAGE"] },
    });
    expect(r.statusCode).toBe(400);
  });
});
