import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import { generateUniqueUid } from "../auth/uid.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let auth = "";
let userId = "";

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.BILLING_BASE_URL ??= "http://localhost:1"; // 不可达 → isModelEnabled 降级放行
  process.env.BILLING_INTERNAL_TOKEN ??= "t";
  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const u = await prisma.user.create({ data: { uid, username: `chatm_${Date.now()}`, passwordHash: "x" } });
  userId = u.id;
  auth = `Bearer ${signToken(userId, process.env.SESSION_SECRET!)}`;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.message.deleteMany({ where: { session: { userId } } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("聊天选模型", () => {
  it("未登录 401", async () => {
    const r = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi" } });
    expect(r.statusCode).toBe(401);
  });
  it("传未启用模型 400（校验集含该 model 才放行；这里 mock isModelEnabled 返回 false）", async () => {
    // billing 不可达会降级放行，故本用例直接 mock 启用集为空 → 校验拒绝
    const mod = await import("./routes.js");
    if ((mod as { __setEnabledForTest?: (s: Set<string>) => void }).__setEnabledForTest) {
      (mod as { __setEnabledForTest: (s: Set<string>) => void }).__setEnabledForTest(new Set(["OnlyThis"]));
    }
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: auth },
      payload: { message: "hi", model: "NotEnabledModel" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("模型");
  });
});
