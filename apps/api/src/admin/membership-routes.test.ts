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
  process.env.BILLING_BASE_URL ??= "http://localhost:1"; // 不可达以触发 502
  process.env.BILLING_INTERNAL_TOKEN ??= "internal-token";

  const secret = process.env.ADMIN_SESSION_SECRET!;
  const a = await createAdmin(prisma, {
    username: `memaadm_${Date.now()}`,
    password: "password123",
    role: "super_admin",
    permissions: [],
  });
  createdAdminIds.push(a.id);
  token = signAdminToken(a.id, secret);

  const b = await createAdmin(prisma, {
    username: `menoperm_${Date.now()}`,
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

describe("admin 月卡管理路由", () => {
  it("无 MEMBERSHIP_MANAGE 返回 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/membership-cards",
      headers: { authorization: `Bearer ${noPermToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("GET /api/admin/membership-cards billing 不可达返回 502", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/membership-cards",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(502);
  });

  it("POST /api/admin/membership-cards 参数缺失返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/membership-cards",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { name: "月卡" }, // 缺 priceFen/durationDays/cadence/grantPoints
    });
    expect(r.statusCode).toBe(400);
  });

  it("POST /api/admin/membership-cards cadence 非法返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/membership-cards",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        name: "月卡",
        priceFen: 30000,
        durationDays: 30,
        cadence: "INVALID",
        grantPoints: 1000,
        enabled: true,
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it("POST /api/admin/membership-cards billing 不可达返回 502", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/membership-cards",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        name: "测试月卡",
        priceFen: 30000,
        durationDays: 30,
        cadence: "DAILY",
        grantPoints: 1000,
        enabled: true,
      },
    });
    expect(r.statusCode).toBe(502);
  });

  it("POST /api/admin/membership-cards/delete billing 不可达返回 502", async () => {
    const deleteR = await app.inject({
      method: "POST",
      url: "/api/admin/membership-cards/delete",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { id: 999 },
    });
    expect(deleteR.statusCode).toBe(502);
  });
});
