import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@yc/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let token = "";
let noPermToken = "";
const createdAdminIds: string[] = [];
const createdUserIds: string[] = [];

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
    username: `baladm_${Date.now()}`,
    password: "password123",
    role: "super_admin",
    permissions: [],
  });
  createdAdminIds.push(a.id);
  token = signAdminToken(a.id, secret);

  const b = await createAdmin(prisma, {
    username: `balnop_${Date.now()}`,
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
  // 自隔离清理：只删除本测试创建的数据
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("admin 余额调整路由", () => {
  it("无 BALANCE_ADJUST 403", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/users/x/balance",
      headers: { authorization: `Bearer ${noPermToken}` },
      payload: { delta: 100, reason: "x" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("delta=0 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/users/x/balance",
      headers: { authorization: `Bearer ${token}` },
      payload: { delta: 0, reason: "x" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("用户不存在 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/users/nonexistent/balance",
      headers: { authorization: `Bearer ${token}` },
      payload: { delta: 100, reason: "test" },
    });
    expect(r.statusCode).toBe(404);
  });
});
