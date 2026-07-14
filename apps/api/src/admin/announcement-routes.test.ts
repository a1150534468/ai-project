import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { createAdmin } from "./service.js";
import { signAdminToken } from "./token.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let tok = "";
const admNames: string[] = [];

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  const n = `adm_an_${Date.now()}`;
  admNames.push(n);
  const a = await createAdmin(prisma, {
    username: n,
    password: "pw12345678",
    role: "admin",
    permissions: ["ANNOUNCEMENT_MANAGE"],
  });
  tok = signAdminToken(a.id, process.env.ADMIN_SESSION_SECRET!);
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.announcement.deleteMany({ where: { title: { startsWith: "T_" } } });
  await prisma.admin.deleteMany({ where: { username: { in: admNames } } });
});

describe("公告", () => {
  it("创建公告 + 公开端点返回生效项", async () => {
    const c = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      headers: { authorization: `Bearer ${tok}` },
      payload: { title: `T_${Date.now()}`, body: "内容", active: true },
    });
    expect(c.statusCode).toBe(200);
    const pub = await app.inject({ method: "GET", url: "/api/announcements" });
    expect(pub.statusCode).toBe(200);
    expect(pub.json<{ success: boolean; data: { id: string; title: string }[] }>().data.some((a) => a.title.startsWith("T_"))).toBe(true);
  });

  it("停用后公开端点不返回", async () => {
    const c = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      headers: { authorization: `Bearer ${tok}` },
      payload: { title: `T_off_${Date.now()}`, body: "x", active: false },
    });
    const id = c.json<{ success: boolean; data: { id: string } }>().data.id;
    const pub = await app.inject({ method: "GET", url: "/api/announcements" });
    expect(pub.json<{ success: boolean; data: { id: string }[] }>().data.some((a) => a.id === id)).toBe(false);
  });
});
