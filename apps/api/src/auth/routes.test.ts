import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
const uname = `u_${Date.now()}`;

beforeAll(async () => {
  // buildServer 会注册全部路由（hub 订阅 Redis、chat 读 LLM 配置），需补齐占位 env
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  // 删除测试用户（只删本文件自建的那个，不能按 "u_" 前缀全表扫，会误删并发跑的其它测试文件的用户）
  await prisma.user.deleteMany({
    where: { username: uname },
  });
  // 删除新增的渠道用户
  await prisma.user.deleteMany({
    where: { username: { in: ["nochan_user_t3", "badchan_user_t3", "goodchan_user_t3", "disabled_chan_user_t3"] } },
  });
  // 删除测试渠道（Task 3）
  await prisma.channel.deleteMany({
    where: { code: { in: ["AA", "TT", "ZZ", "DD"] } },
  });
});

describe("auth 身份重构", () => {
  let uid = "";
  let token = "";
  let defaultChannelId = "";

  beforeAll(async () => {
    // 为现有用例创建默认渠道
    const ch = await prisma.channel.create({
      data: { code: "AA", ownerType: "PLATFORM", commissionRate: 0, enabled: true },
    });
    defaultChannelId = ch.id;
  });

  it("注册返回前缀 uid", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: uname, password: "password123", channelCode: "AA" },
    });
    expect(r.statusCode).toBe(200);
    uid = r.json().uid;
    expect(uid).toMatch(/^AA-\d{8}$/);
    const user = await prisma.user.findUnique({ where: { uid }, select: { memoryEnabled: true } });
    expect(user?.memoryEnabled).toBe(true);
  });
  it("用户名重复 409", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: uname, password: "password123", channelCode: "AA" },
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

  // Task 3: 分销代理 - 注册强制填渠道码
  it("注册缺少 channelCode → 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "nochan_user_t3", password: "password123" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("注册用无效 channelCode → 400 注册码无效", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "badchan_user_t3", password: "password123", channelCode: "ZZ" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("注册码");
  });

  it("注册用有效 channelCode → 绑定 channelId 且 UID 带前缀", async () => {
    const ch = await prisma.channel.create({
      data: { code: "TT", ownerType: "PLATFORM", commissionRate: 0, enabled: true },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "goodchan_user_t3", password: "password123", channelCode: "TT" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().uid).toMatch(/^TT-\d{8}$/);
    const u = await prisma.user.findUnique({ where: { username: "goodchan_user_t3" } });
    expect(u?.channelId).toBe(ch.id);
  });

  it("注册用已禁用渠道 → 400 注册码无效", async () => {
    await prisma.channel.create({
      data: { code: "DD", ownerType: "PLATFORM", commissionRate: 0, enabled: false },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "disabled_chan_user_t3", password: "password123", channelCode: "DD" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("注册码");
  });
});
