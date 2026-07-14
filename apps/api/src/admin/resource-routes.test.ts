import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signAdminToken } from "./token.js";
import { createAdmin } from "./service.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let pricingAdmin = "";
let otherAdmin = "";
const createdAdminIds: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1"; // 不可达
  process.env.BILLING_INTERNAL_TOKEN ??= "t";

  const secret = process.env.ADMIN_SESSION_SECRET!;
  const a = await createAdmin(prisma, {
    username: `pricadm_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["PRICING_MANAGE"],
  });
  createdAdminIds.push(a.id);
  pricingAdmin = signAdminToken(a.id, secret);

  const b = await createAdmin(prisma, {
    username: `otheradm_${Date.now()}`,
    password: "password123",
    role: "admin",
    permissions: ["MODEL_MANAGE"],
  });
  createdAdminIds.push(b.id);
  otherAdmin = signAdminToken(b.id, secret);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // 自隔离清理：只删除本测试创建的 admin
  await prisma.adminAudit.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
});

describe("admin 资源计价路由", () => {
  it("无 PRICING_MANAGE 权限调 GET /api/admin/resource-prices 返回 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${otherAdmin}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("upsert 参数不合法返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { resourceKey: "" }, // 缺少必要字段
    });
    expect(r.statusCode).toBe(400);
  });

  it("upsert 非法 pricingType 返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: {
        resourceKey: "test",
        displayName: "Test",
        pricingType: "INVALID",
        rate: 10,
        perUnits: 1,
        enabled: true,
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it("BILLING_BASE_URL 不可达 list 返回 502", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${pricingAdmin}` },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error).toBeDefined();
  });

  it("BILLING_BASE_URL 不可达 upsert 返回 502", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: {
        resourceKey: "websearch",
        displayName: "Web Search",
        pricingType: "PER_CALL",
        rate: 10,
        perUnits: 1,
        enabled: true,
      },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error).toBeDefined();
  });

  it("upsert VIDEO_IO（含 outputRate）通过校验（502 而非 400）", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: {
        resourceKey: "video_seedance_2_720p_with_video",
        displayName: "Seedance-2.0 720p 有输入视频",
        pricingType: "VIDEO_IO",
        rate: 2,
        outputRate: 5,
        perUnits: 1,
        enabled: true,
      },
    });
    // 校验通过则走到 billing（不可达 → 502）；若被 schema 拦下会是 400
    expect(r.statusCode).toBe(502);
  });

  it("BILLING_BASE_URL 不可达 delete 返回 502", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices/delete",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { resourceKey: "websearch" },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error).toBeDefined();
  });

  it("delete 参数不合法返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/admin/resource-prices/delete",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it("无 PRICING_MANAGE 权限调 GET /api/admin/config/recharge-ratio 返回 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/config/recharge-ratio",
      headers: { authorization: `Bearer ${otherAdmin}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("BILLING_BASE_URL 不可达 getRechargeRatio 返回 502", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/config/recharge-ratio",
      headers: { authorization: `Bearer ${pricingAdmin}` },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error).toBeDefined();
  });

  it("无 PRICING_MANAGE 权限调 PUT /api/admin/config/recharge-ratio 返回 403", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/admin/config/recharge-ratio",
      headers: { authorization: `Bearer ${otherAdmin}` },
      payload: { ratio: 100 },
    });
    expect(r.statusCode).toBe(403);
  });

  it("setRechargeRatio 参数不合法返回 400", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/admin/config/recharge-ratio",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { ratio: "invalid" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("BILLING_BASE_URL 不可达 setRechargeRatio 返回 502", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/admin/config/recharge-ratio",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { ratio: 100 },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error).toBeDefined();
  });

  it("无 PRICING_MANAGE 权限调 GET /api/admin/config/recharge-packages 返回 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/config/recharge-packages",
      headers: { authorization: `Bearer ${otherAdmin}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("setRechargePackages 参数不合法返回 400", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/admin/config/recharge-packages",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { packages: [{ id: "", name: "bad", amountFen: 0, points: 0, enabled: true, sortOrder: 1 }] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("setRechargePackages 超过 10 个返回 400", async () => {
    const packages = Array.from({ length: 11 }, (_, i) => ({
      id: `pkg_${i + 1}`,
      name: `套餐 ${i + 1}`,
      amountFen: (i + 1) * 100,
      points: (i + 1) * 100,
      enabled: true,
      sortOrder: i + 1,
    }));
    const r = await app.inject({
      method: "PUT",
      url: "/api/admin/config/recharge-packages",
      headers: { authorization: `Bearer ${pricingAdmin}` },
      payload: { packages },
    });
    expect(r.statusCode).toBe(400);
  });

  it("BILLING_BASE_URL 不可达 getRechargePackages 返回 502", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/config/recharge-packages",
      headers: { authorization: `Bearer ${pricingAdmin}` },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBeDefined();
  });
});
