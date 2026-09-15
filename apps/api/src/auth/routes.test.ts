import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
const uname = `u_${Date.now()}`;
const demoUname = `demo_${Date.now()}`;
const demoPassword = "demo-password-123";
const previousDemoEnv = {
  enabled: process.env.DEMO_ACCOUNT_ENABLED,
  username: process.env.DEMO_ACCOUNT_USERNAME,
  password: process.env.DEMO_ACCOUNT_PASSWORD,
};

beforeAll(async () => {
  // buildServer 会注册全部路由（hub 订阅 Redis、chat 读 LLM 配置），需补齐占位 env
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.DEMO_ACCOUNT_ENABLED = "true";
  process.env.DEMO_ACCOUNT_USERNAME = demoUname;
  process.env.DEMO_ACCOUNT_PASSWORD = demoPassword;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  // 删除测试用户（只删本文件自建的那个，不能按 "u_" 前缀全表扫，会误删并发跑的其它测试文件的用户）
  await prisma.user.deleteMany({ where: { username: { in: [uname, demoUname] } } });
  if (previousDemoEnv.enabled === undefined) delete process.env.DEMO_ACCOUNT_ENABLED;
  else process.env.DEMO_ACCOUNT_ENABLED = previousDemoEnv.enabled;
  if (previousDemoEnv.username === undefined) delete process.env.DEMO_ACCOUNT_USERNAME;
  else process.env.DEMO_ACCOUNT_USERNAME = previousDemoEnv.username;
  if (previousDemoEnv.password === undefined) delete process.env.DEMO_ACCOUNT_PASSWORD;
  else process.env.DEMO_ACCOUNT_PASSWORD = previousDemoEnv.password;
});

describe("auth 身份重构", () => {
  let uid = "";
  let token = "";

  it("注册无需注册码", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: uname, password: "password123" },
    });
    expect(r.statusCode).toBe(200);
    uid = r.json().uid;
    expect(uid).toMatch(/^\d{8}$/);
    const user = await prisma.user.findUnique({
      where: { uid },
      select: { memoryEnabled: true },
    });
    expect(user?.memoryEnabled).toBe(true);
  });
  it("用户名重复 409", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: uname, password: "password123" },
    });
    expect(r.statusCode).toBe(409);
  });
  it("用用户名登录成功", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: uname, password: "password123" },
    });
    expect(r.statusCode).toBe(200);
    token = r.json().token;
    expect(token).toBeTruthy();
  });
  it("记忆设置默认开启且可读取", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/memory/settings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.memoryEnabled).toBe(true);
  });
  it("/me 返回当前用户资料", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.uid).toBe(uid);
    expect(body.username).toBe(uname);
    expect(body.userId).toBeTruthy();
  });
  it("/me 未带 token 401", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(r.statusCode).toBe(401);
    // 必须断 body：摘掉 preHandler 后 req.userId 是装饰器默认空串，
    // findUnique 拿不到人会走下一行的「用户不存在」，那也是 401，只断 statusCode 会假绿。
    expect(r.json()).toEqual({ error: "未登录" });
  });
  it("用 uid 登录成功", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: uid, password: "password123" },
    });
    expect(r.statusCode).toBe(200);
  });
  it("密码错 401", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: uname, password: "wrong" },
    });
    expect(r.statusCode).toBe(401);
  });
  it("封禁后登录 403", async () => {
    await prisma.user.update({ where: { uid }, data: { bannedAt: new Date() } });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: uname, password: "password123" },
    });
    expect(r.statusCode).toBe(403);
  });
  it("封禁后 /me 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("面试体验账号", () => {
  it("公开返回配置但不返回密码", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/demo-config" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ enabled: true, username: demoUname });
    expect(r.body).not.toContain(demoPassword);
  });

  it("惰性创建前预留演示用户名，普通注册不能抢占", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: demoUname, password: demoPassword },
    });
    expect(r.statusCode).toBe(409);
    expect(await prisma.user.findUnique({ where: { username: demoUname } })).toBeNull();
  });

  it("首次进入自动创建，重复进入复用同一个用户", async () => {
    const first = await app.inject({ method: "POST", url: "/api/auth/demo" });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.token).toBeTruthy();
    const created = await prisma.user.findUnique({ where: { username: demoUname } });
    expect(created?.uid).toBe(firstBody.uid);

    const second = await app.inject({ method: "POST", url: "/api/auth/demo" });
    expect(second.statusCode).toBe(200);
    expect(second.json().userId).toBe(firstBody.userId);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${firstBody.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe(demoUname);
  });
});
