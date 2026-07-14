import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import { generateUniqueUid } from "../auth/uid.js";

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let userId = "";
let auth = "";

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.CORS_ORIGIN ??= "http://localhost:3000";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:8000";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);

  const uid = await generateUniqueUid(
    async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } }))
  );
  const u = await prisma.user.create({
    data: { uid, username: `devr_${Date.now()}`, passwordHash: "x" },
  });
  userId = u.id;
  auth = `Bearer ${signToken(userId, process.env.SESSION_SECRET!)}`;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.device.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("device routes", () => {
  it("未登录配对返回 401", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/device/pair",
      payload: { name: "x", platform: "win" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("配对→列表→吊销 闭环", async () => {
    const pair = await app.inject({
      method: "POST",
      url: "/api/device/pair",
      headers: { authorization: auth },
      payload: { name: "我的电脑", platform: "win" },
    });
    expect(pair.statusCode).toBe(200);
    const { deviceId, token } = pair.json();
    expect(token).toBeTruthy();

    const list = await app.inject({
      method: "GET",
      url: "/api/device/list",
      headers: { authorization: auth },
    });
    expect(list.json().data.some((d: { id: string }) => d.id === deviceId)).toBe(true);

    const rev = await app.inject({
      method: "POST",
      url: `/api/device/${deviceId}/revoke`,
      headers: { authorization: auth },
    });
    expect(rev.statusCode).toBe(200);
  });
});
