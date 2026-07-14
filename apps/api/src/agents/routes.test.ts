import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import FormData from "form-data";
import sharp from "sharp";
import { getPrisma } from "@ai-assistant/db";
import { generateUniqueUid } from "../auth/uid.js";
import { agentRoutes } from "./routes.js";

vi.mock("@ai-assistant/llm", () => ({
  loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "key", defaultModel: "GLM-5.2" }),
  createLlmClient: () => ({
    messages: {
      create: vi.fn(async ({ model, system }: { model: string; system: string }) => {
        if (model === "mimo-v2.5-pro-ultraspeed") throw new Error("primary unavailable");
        if (system.includes("SVG")) {
          return { content: [{ type: "text", text: '<g stroke-width="2"><path d="M4 4h16"/></g>' }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: "复盘教练",
              description: "帮助用户复盘项目和行动",
              systemPrompt: "你是复盘教练，帮助用户拆解事实、洞察和下一步。",
            }),
          }],
        };
      }),
    },
  }),
}));

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof makeApp>>;
let userId = "";

const redisCounts = new Map<string, number>();
const fakeRedis = {
  incr: async (k: string) => {
    const n = (redisCounts.get(k) ?? 0) + 1;
    redisCounts.set(k, n);
    return n;
  },
  expire: async () => 1,
} as never;

const putCalls: Array<{ key: string; mime: string }> = [];
const deleteCalls: string[] = [];
const fakeStorage = {
  put: async (key: string, _body: Buffer, mime: string) => {
    putCalls.push({ key, mime });
  },
  remove: async (key: string) => {
    deleteCalls.push(key);
  },
};

async function makeApp() {
  const f = Fastify();
  f.decorateRequest("userId", "");
  f.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      (req as unknown as { userId: string }).userId = auth.slice(7);
    }
  });
  await f.register(multipart, { limits: { fileSize: 20971520 } });
  await f.register(agentRoutes, { redis: fakeRedis, storage: fakeStorage });
  await f.ready();
  return f;
}

async function uploadAvatar(agentId: string, buf: Buffer, filename: string, token = userId) {
  const form = new FormData();
  form.append("file", buf, { filename, contentType: "image/png" });
  return app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/avatar/upload`,
    headers: { authorization: `Bearer ${token}`, ...form.getHeaders() },
    payload: form,
  });
}

async function realPng() {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const u = await prisma.user.create({ data: { uid, username: `agent_${Date.now()}`, passwordHash: "x" } });
  userId = u.id;
  app = await makeApp();
});

beforeEach(async () => {
  await prisma.userAgent.deleteMany({ where: { userId } });
  redisCounts.clear();
  putCalls.length = 0;
  deleteCalls.length = 0;
});

afterAll(async () => {
  await app.close();
  await prisma.userAgent.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("agent routes", () => {
  it("lists preset agents", async () => {
    const r = await app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${userId}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data.presets.length).toBeGreaterThanOrEqual(80);
    expect(body.data.presets[0].prompt).toBeUndefined();
    expect(body.data.custom).toEqual([]);
  });

  it("generates a custom agent with fallback model", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/agents/generate",
      headers: { authorization: `Bearer ${userId}` },
      payload: { requirement: "帮我做项目复盘" },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data.name).toBe("复盘教练");
    expect(body.data.modelUsed).toBe("MiniMax-M3");

    const saved = await prisma.userAgent.findFirst({ where: { userId, name: "复盘教练" } });
    expect(saved?.prompt).toContain("复盘教练");
  });

  it("GET /api/agents 的 custom 带出 avatarSvg / avatarUrl", async () => {
    await prisma.userAgent.create({
      data: { userId, name: "法务", description: "合同", prompt: "p", avatarSvg: '<g><path d="M1 1"/></g>' },
    });
    const r = await app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${userId}` } });
    expect(r.statusCode).toBe(200);
    const custom = r.json().data.custom as Array<{ avatarSvg: string | null; avatarUrl: string | null }>;
    expect(custom[0].avatarSvg).toContain("M1 1");
    expect(custom[0].avatarUrl).toBeNull();
  });

  it("PATCH /api/agents/:id 重命名", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "旧名", prompt: "p" } });
    const r = await app.inject({
      method: "PATCH", url: `/api/agents/${a.id}`,
      headers: { authorization: `Bearer ${userId}` },
      payload: { name: "新名" },
    });
    expect(r.statusCode).toBe(200);
    expect((await prisma.userAgent.findUnique({ where: { id: a.id } }))!.name).toBe("新名");
  });

  it("PATCH 别人的 Agent → 404，且不改动数据", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "我的", prompt: "p" } });
    const r = await app.inject({
      method: "PATCH", url: `/api/agents/${a.id}`,
      headers: { authorization: "Bearer someone-else" },
      payload: { name: "被改了" },
    });
    expect(r.statusCode).toBe(404);
    expect((await prisma.userAgent.findUnique({ where: { id: a.id } }))!.name).toBe("我的");
  });

  it("PATCH 空名 → 400", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const r = await app.inject({
      method: "PATCH", url: `/api/agents/${a.id}`,
      headers: { authorization: `Bearer ${userId}` },
      payload: { name: "   " },
    });
    expect(r.statusCode).toBe(400);
  });

  it("DELETE /api/agents/:id 级联删除其对话与消息", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "待删", prompt: "p" } });
    const s = await prisma.session.create({ data: { userId, title: "对话1", agentId: a.id } });
    await prisma.message.create({ data: { sessionId: s.id, role: "user", content: "hi" } });
    const other = await prisma.session.create({ data: { userId, title: "别的对话", agentId: "preset-1" } });

    const r = await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { authorization: `Bearer ${userId}` } });
    expect(r.statusCode).toBe(200);

    expect(await prisma.userAgent.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: s.id } })).toBeNull();
    expect(await prisma.message.count({ where: { sessionId: s.id } })).toBe(0);
    expect(await prisma.session.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("DELETE 别人的 Agent → 404，且数据不动", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "我的", prompt: "p" } });
    const r = await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { authorization: "Bearer someone-else" } });
    expect(r.statusCode).toBe(404);
    expect(await prisma.userAgent.findUnique({ where: { id: a.id } })).not.toBeNull();
  });

  it("POST /api/agents/:id/avatar/regenerate 重画头像", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "法务", description: "合同", prompt: "p" } });
    const r = await app.inject({ method: "POST", url: `/api/agents/${a.id}/avatar/regenerate`, headers: { authorization: `Bearer ${userId}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.avatarSvg).toContain("M4 4h16");
    expect((await prisma.userAgent.findUnique({ where: { id: a.id } }))!.avatarSvg).toContain("M4 4h16");
  });

  it("regenerate 别人的 Agent → 404", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const r = await app.inject({ method: "POST", url: `/api/agents/${a.id}/avatar/regenerate`, headers: { authorization: "Bearer someone-else" } });
    expect(r.statusCode).toBe(404);
  });

  it("regenerate 超过每小时 20 次 → 429", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const hit = async () => app.inject({ method: "POST", url: `/api/agents/${a.id}/avatar/regenerate`, headers: { authorization: `Bearer ${userId}` } });
    for (let i = 0; i < 20; i++) expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);
  });

  it("上传 PNG → 存 webp，写入 avatarUrl（object key）", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const r = await uploadAvatar(a.id, await realPng(), "me.png");
    expect(r.statusCode).toBe(200);
    expect(putCalls[0].mime).toBe("image/webp");
    expect(putCalls[0].key).toMatch(new RegExp(`^agent-avatars/${userId}/${a.id}/`));
    const key = putCalls[0].key;
    expect((await prisma.userAgent.findUnique({ where: { id: a.id } }))!.avatarUrl).toBe(key);
    expect(r.json().data.avatarUrl).toBe(key); // 测试环境无 S3，回落原样
  });

  it("上传 SVG 伪装成 .png → 400，且不落 S3", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const r = await uploadAvatar(a.id, Buffer.from('<svg onload="alert(1)"/>'), "evil.png");
    expect(r.statusCode).toBe(400);
    expect(putCalls).toHaveLength(0);
  });

  it("上传别人的 Agent → 404，且不落 S3", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const r = await uploadAvatar(a.id, await realPng(), "me.png", "someone-else");
    expect(r.statusCode).toBe(404);
    expect(putCalls).toHaveLength(0);
  });

  it("换新头像时删掉旧对象", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p", avatarUrl: "agent-avatars/old.webp" } });
    await uploadAvatar(a.id, await realPng(), "me.png");
    await new Promise((r) => setImmediate(r)); // 等 best-effort 删除
    expect(deleteCalls).toContain("agent-avatars/old.webp");
  });

  it("上传超过 20 次/小时 → 429", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const png = await realPng();
    for (let i = 0; i < 20; i++) expect((await uploadAvatar(a.id, png, "me.png")).statusCode).toBe(200);
    expect((await uploadAvatar(a.id, png, "me.png")).statusCode).toBe(429);
  });

  it("删 Agent 时删掉其头像对象", async () => {
    const a = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p", avatarUrl: "agent-avatars/x.webp" } });
    await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { authorization: `Bearer ${userId}` } });
    await new Promise((r) => setImmediate(r));
    expect(deleteCalls).toContain("agent-avatars/x.webp");
  });
});
