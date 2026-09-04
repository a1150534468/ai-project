import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
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
});

describe("聊天路由", () => {
  it("未登录 401", async () => {
    const r = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi" } });
    expect(r.statusCode).toBe(401);
  });
});
