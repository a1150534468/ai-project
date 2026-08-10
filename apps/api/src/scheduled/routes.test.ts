import { describe, it, expect, beforeAll, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import { scheduledRoutes } from "./routes.js";
import { RateLimitedError } from "./ai-draft-glue.js";

const prisma = getPrisma();
const CREATED: string[] = [];

function appAs(userId: string): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = userId;
  });
  return app;
}

async function seedUser(id: string) {
  await prisma.user.upsert({
    where: { id },
    update: {},
    create: { id, uid: id, username: id, passwordHash: "x" },
  });
}

const OK = {
  title: "T",
  prompt: "p",
  model: "MiniMax-M3",
  cron: "0 8 * * *",
  timezone: "Asia/Shanghai",
  emailTo: "a@b.com",
};

describe("scheduledRoutes", () => {
  beforeAll(async () => {
    await seedUser("su1");
    await seedUser("su2");
  });

  afterEach(async () => {
    await prisma.scheduledTask.deleteMany({ where: { id: { in: CREATED } } });
    CREATED.length = 0;
  });

  it("POST 建任务：算出 nextRunAt，属主为当前用户", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app);
    const res = await app.inject({ method: "POST", url: "/api/scheduled-tasks", payload: OK });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    CREATED.push(body.id);
    expect(body.userId).toBe("su1");
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await app.close();
  });

  it("POST 拒绝过密 cron（每分钟）", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: { ...OK, cron: "* * * * *", timezone: "UTC" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST 拒绝非法邮箱", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: { ...OK, emailTo: "bad" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST 允许不填邮箱建任务（emailTo 可选，存空串）", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app);
    const { emailTo, ...noEmail } = OK;
    void emailTo;
    const res = await app.inject({ method: "POST", url: "/api/scheduled-tasks", payload: noEmail });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    CREATED.push(body.id);
    expect(body.emailTo).toBe("");
    await app.close();
  });

  it("GET /:id 越权返回 404", async () => {
    const own = appAs("su1");
    await scheduledRoutes(own);
    const created = await own.inject({ method: "POST", url: "/api/scheduled-tasks", payload: OK });
    const id = created.json().id;
    CREATED.push(id);
    await own.close();

    const other = appAs("su2");
    await scheduledRoutes(other);
    const res = await other.inject({ method: "GET", url: `/api/scheduled-tasks/${id}/runs` });
    expect(res.statusCode).toBe(404);
    await other.close();
  });

  it("DELETE 越权返回 404，本人可删", async () => {
    const own = appAs("su1");
    await scheduledRoutes(own);
    const created = await own.inject({ method: "POST", url: "/api/scheduled-tasks", payload: OK });
    const id = created.json().id;
    CREATED.push(id);

    const other = appAs("su2");
    await scheduledRoutes(other);
    expect((await other.inject({ method: "DELETE", url: `/api/scheduled-tasks/${id}` })).statusCode).toBe(404);
    await other.close();

    expect((await own.inject({ method: "DELETE", url: `/api/scheduled-tasks/${id}` })).statusCode).toBe(200);
    await own.close();
  });

  it("POST /ai-draft 未登录 401", async () => {
    const app = Fastify();
    app.decorateRequest("userId", "");
    await scheduledRoutes(app, {
      aiDraft: async () => ({
        title: "T",
        prompt: "P",
        model: "m",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        hour: 9,
        minute: 0,
        oneShot: false,
        emailTo: "",
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /ai-draft 空描述 400", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app, {
      aiDraft: async () => ({
        title: "T",
        prompt: "P",
        model: "m",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        hour: 9,
        minute: 0,
        oneShot: false,
        emailTo: "",
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /ai-draft 正常返回草稿（不落库）", async () => {
    const app = appAs("su1");
    const draft = {
      title: "早报",
      prompt: "汇总要闻",
      model: "MiniMax-M3",
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
      hour: 8,
      minute: 0,
      oneShot: false,
      emailTo: "a@b.com",
    };
    await scheduledRoutes(app, { aiDraft: async () => draft });
    const before = await prisma.scheduledTask.count({ where: { userId: "su1" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "每天八点早报" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(draft);
    const after = await prisma.scheduledTask.count({ where: { userId: "su1" } });
    expect(after).toBe(before);
    await app.close();
  });

  it("POST /ai-draft 未注入 aiDraft → 503", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("POST /ai-draft 限流 → 429", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app, {
      aiDraft: async () => {
        throw new RateLimitedError();
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it("POST /ai-draft 余额不足 → 400", async () => {
    const app = appAs("su1");
    await scheduledRoutes(app, {
      aiDraft: async () => {
        throw new InsufficientBalanceError();
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks/ai-draft",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
