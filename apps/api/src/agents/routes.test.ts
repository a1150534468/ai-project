import multipart from "@fastify/multipart";
import { getPrisma } from "@ai-assistant/db";
import Fastify from "fastify";
import FormData from "form-data";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { generateUniqueUid } from "../auth/uid.js";
import { agentRoutes } from "./routes.js";

/**
 * 假的模型网关。三件事都在这里定好：
 *
 * - 主模型**一定失败** —— 于是每条用例都顺带验了「换备用模型重试」这条路；
 * - 画头像那一路（靠 system prompt 认，不猜子串）回一段合法线稿；
 * - 生成配置那一路回一份合法 JSON。
 *
 * 工厂写成 async 并在里面动态 import，是为了拿到 `AVATAR_SYSTEM` 常量而不踩
 * 「vi.mock 提升到 import 之前」那个初始化顺序的坑。
 */
vi.mock("@ai-assistant/llm", async () => {
  const { AVATAR_SYSTEM } = await import("./avatar.js");

  return {
    loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "key", defaultModel: "GLM-5.2" }),
    createLlmClient: () => ({
      messages: {
        create: async ({ model, system }: { model: string; system: string }) => {
          if (model === "mimo-v2.5-pro-ultraspeed") throw new Error("primary unavailable");

          if (system === AVATAR_SYSTEM) {
            return { content: [{ type: "text", text: '<g stroke-width="2"><path d="M4 4h16"/></g>' }] };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: "复盘教练",
                  description: "帮助用户复盘项目和行动",
                  systemPrompt: "你是复盘教练，帮助用户拆解事实、洞察和下一步。",
                }),
              },
            ],
          };
        },
      },
    }),
  };
});

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof makeApp>>;
let userId = "";

/** 假 Redis：只实现限流器真正用到的 `MULTI(INCR, TTL) / EXEC` 和 `EXPIRE`。 */
const redisCounts = new Map<string, number>();
const redisTtls = new Map<string, number>();

const fakeRedis = {
  multi: () => {
    const queued: (() => number)[] = [];
    const chain = {
      incr: (key: string) => {
        queued.push(() => {
          const next = (redisCounts.get(key) ?? 0) + 1;
          redisCounts.set(key, next);
          return next;
        });
        return chain;
      },
      ttl: (key: string) => {
        queued.push(() => redisTtls.get(key) ?? -1);
        return chain;
      },
      exec: async () => queued.map((run) => [null, run()]),
    };
    return chain;
  },
  expire: async (key: string, seconds: number) => {
    redisTtls.set(key, seconds);
    return 1;
  },
} as never;

/** 假对象存储：只记调用，不真的传字节。断言靠这两个数组。 */
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

/**
 * 一个只挂了这一个插件的裸 Fastify。
 *
 * 鉴权用一个极简的 onRequest 替掉真的 JWT 校验：`Bearer <userId>` 直接当成登录成功。
 * 不带头时 `req.userId` 落在 `decorateRequest` 的默认空串上 —— 这和线上「带了 token 但验签失败」
 * 是同一条路径，所以下面那条 401 用例验的是真东西。
 */
async function makeApp() {
  const instance = Fastify();

  instance.decorateRequest("userId", "");
  instance.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) req.userId = auth.slice(7);
  });

  await instance.register(multipart, { limits: { fileSize: 20971520 } });
  await instance.register(agentRoutes, { redis: fakeRedis, storage: fakeStorage });
  await instance.ready();

  return instance;
}

/** contentType 故意写死 image/png：上传接口不该信它，认格式只看字节。 */
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

/** 真的 PNG 字节。假造文件头没用 —— 上传这条路会真的过一遍 sharp。 */
const realPng = () =>
  sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();

const asUser = (token = userId) => ({ authorization: `Bearer ${token}` });

/** 等一轮微任务，让路由里那些 `void ...catch()` 的 best-effort 删除跑完。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(async () => {
  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const user = await prisma.user.create({ data: { uid, username: `agent_${Date.now()}`, passwordHash: "x" } });
  userId = user.id;
  app = await makeApp();
});

beforeEach(async () => {
  await prisma.userAgent.deleteMany({ where: { userId } });
  redisCounts.clear();
  redisTtls.clear();
  putCalls.length = 0;
  deleteCalls.length = 0;
});

afterAll(async () => {
  await app.close();
  await prisma.userAgent.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("GET /api/agents", () => {
  it("内置和自建分两组，且**提示词不出仓**", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: asUser() });

    expect(res.statusCode).toBe(200);
    const { presets, custom } = res.json().data;
    expect(presets[0]).toMatchObject({ id: "preset-1", type: "preset" });
    expect(presets.every((one: Record<string, unknown>) => one.prompt === undefined)).toBe(true);
    expect(custom).toEqual([]);
  });

  it("自建 Agent 带出 avatarSvg 和 avatarUrl", async () => {
    await prisma.userAgent.create({
      data: { userId, name: "法务", description: "合同", prompt: "p", avatarSvg: '<g><path d="M1 1"/></g>' },
    });

    const res = await app.inject({ method: "GET", url: "/api/agents", headers: asUser() });

    const custom = res.json().data.custom as Array<{ avatarSvg: string | null; avatarUrl: string | null }>;
    expect(custom[0].avatarSvg).toContain("M1 1");
    // 没上传过位图，所以是 null；测试环境没有 S3，有值时也只会原样回 key
    expect(custom[0].avatarUrl).toBeNull();
  });
});

describe("POST /api/agents/generate", () => {
  // 假网关里主模型必然失败，所以这条用例同时验了「换备用模型再来一次」
  it("主模型挂了就用备用模型，结果落库", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/generate",
      headers: asUser(),
      payload: { requirement: "帮我做项目复盘" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ name: "复盘教练", modelUsed: "MiniMax-M3" });

    const saved = await prisma.userAgent.findFirst({ where: { userId, name: "复盘教练" } });
    expect(saved?.prompt).toContain("复盘教练");
    // 头像用的是「实际成功的那个模型」，所以线稿也应该画出来了
    expect(saved?.avatarSvg).toContain("M4 4h16");
  });

  it("需求太短 → 400，不落库", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/generate",
      headers: asUser(),
      payload: { requirement: "好" },
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.userAgent.count({ where: { userId } })).toBe(0);
  });
});

describe("PATCH /api/agents/:id", () => {
  it("改名", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "旧名", prompt: "p" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: asUser(),
      payload: { name: "新名" },
    });

    expect(res.statusCode).toBe(200);
    expect((await prisma.userAgent.findUnique({ where: { id: agent.id } }))?.name).toBe("新名");
  });

  // 别人的 Agent 和不存在的 Agent 必须得到同一个回复，否则 404/200 的差别就是一条枚举信道
  it("别人的 Agent → 404，数据不动", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "我的", prompt: "p" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: asUser("someone-else"),
      payload: { name: "被改了" },
    });

    expect(res.statusCode).toBe(404);
    expect((await prisma.userAgent.findUnique({ where: { id: agent.id } }))?.name).toBe("我的");
  });

  it("只有空格的名字 → 400（trim 之后是空的）", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: asUser(),
      payload: { name: "   " },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/agents/:id", () => {
  // Session.agentId 没有外键，级联是手写的，所以这条用例要连着会话和消息一起验
  it("连它的会话和消息一起删，别的会话不受影响", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "待删", prompt: "p" } });
    const session = await prisma.session.create({ data: { userId, title: "对话1", agentId: agent.id } });
    await prisma.message.create({ data: { sessionId: session.id, role: "user", content: "hi" } });
    const untouched = await prisma.session.create({ data: { userId, title: "别的对话", agentId: "preset-1" } });

    const res = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(await prisma.userAgent.findUnique({ where: { id: agent.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await prisma.message.count({ where: { sessionId: session.id } })).toBe(0);
    expect(await prisma.session.findUnique({ where: { id: untouched.id } })).not.toBeNull();
  });

  it("别人的 Agent → 404，数据不动", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "我的", prompt: "p" } });

    const res = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: asUser("someone-else") });

    expect(res.statusCode).toBe(404);
    expect(await prisma.userAgent.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });

  it("顺手删掉它的头像文件", async () => {
    const agent = await prisma.userAgent.create({
      data: { userId, name: "x", prompt: "p", avatarUrl: "agent-avatars/x.webp" },
    });

    await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: asUser() });
    await flush();

    expect(deleteCalls).toContain("agent-avatars/x.webp");
  });
});

describe("POST /api/agents/:id/avatar/regenerate", () => {
  it("重画并写库", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "法务", description: "合同", prompt: "p" } });

    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/avatar/regenerate`,
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.avatarSvg).toContain("M4 4h16");
    expect((await prisma.userAgent.findUnique({ where: { id: agent.id } }))?.avatarSvg).toContain("M4 4h16");
  });

  it("别人的 Agent → 404", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });

    const res = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/avatar/regenerate`,
      headers: asUser("someone-else"),
    });

    expect(res.statusCode).toBe(404);
  });

  it("一小时 20 次，第 21 次 → 429", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const hit = () =>
      app.inject({ method: "POST", url: `/api/agents/${agent.id}/avatar/regenerate`, headers: asUser() });

    for (let i = 0; i < 20; i++) expect((await hit()).statusCode).toBe(200);

    expect((await hit()).statusCode).toBe(429);
  });
});

describe("POST /api/agents/:id/avatar/upload", () => {
  it("PNG 进来、webp 出去，库里存的是 object key", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });

    const res = await uploadAvatar(agent.id, await realPng(), "me.png");

    expect(res.statusCode).toBe(200);
    expect(putCalls[0].mime).toBe("image/webp");
    expect(putCalls[0].key).toMatch(new RegExp(`^agent-avatars/${userId}/${agent.id}/\\d+\\.webp$`));

    const key = putCalls[0].key;
    expect((await prisma.userAgent.findUnique({ where: { id: agent.id } }))?.avatarUrl).toBe(key);
    // 测试环境没配 S3，avatarPublicUrl 原样回 key
    expect(res.json().data.avatarUrl).toBe(key);
  });

  it("SVG 改名成 .png 也进不来 → 400，一个字节都不落存储", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });

    const res = await uploadAvatar(agent.id, Buffer.from('<svg onload="alert(1)"/>'), "evil.png");

    expect(res.statusCode).toBe(400);
    expect(putCalls).toHaveLength(0);
  });

  it("别人的 Agent → 404，不落存储", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });

    const res = await uploadAvatar(agent.id, await realPng(), "me.png", "someone-else");

    expect(res.statusCode).toBe(404);
    expect(putCalls).toHaveLength(0);
  });

  it("换新头像时把旧文件删掉", async () => {
    const agent = await prisma.userAgent.create({
      data: { userId, name: "x", prompt: "p", avatarUrl: "agent-avatars/old.webp" },
    });

    await uploadAvatar(agent.id, await realPng(), "me.png");
    await flush();

    expect(deleteCalls).toContain("agent-avatars/old.webp");
  });

  it("一小时 20 次，第 21 次 → 429", async () => {
    const agent = await prisma.userAgent.create({ data: { userId, name: "x", prompt: "p" } });
    const png = await realPng();

    for (let i = 0; i < 20; i++) expect((await uploadAvatar(agent.id, png, "me.png")).statusCode).toBe(200);

    expect((await uploadAvatar(agent.id, png, "me.png")).statusCode).toBe(429);
  });
});

/**
 * 守卫是插件级的 preHandler（见 routes.ts），一条一条挂容易漏；这条用例把 6 条路由全扫一遍。
 *
 * 不光看状态码，还要确认这一轮**什么都没写** —— 401 之后仍然落了库或者传了文件，
 * 那 401 就只是个装饰。
 */
describe("未登录", () => {
  it("6 条路由全部 401，且不写库、不碰对象存储", async () => {
    const agentsBefore = await prisma.userAgent.count();
    const cases = [
      { method: "GET" as const, url: "/api/agents" },
      { method: "POST" as const, url: "/api/agents/generate", payload: { requirement: "复盘一下" } },
      { method: "PATCH" as const, url: "/api/agents/some-id", payload: { name: "x" } },
      { method: "DELETE" as const, url: "/api/agents/some-id" },
      { method: "POST" as const, url: "/api/agents/some-id/avatar/regenerate" },
      { method: "POST" as const, url: "/api/agents/some-id/avatar/upload" },
    ];

    for (const one of cases) {
      const res = await app.inject(one);
      const where = `${one.method} ${one.url}`;
      expect(res.statusCode, where).toBe(401);
      expect(res.json(), where).toEqual({ error: "未登录" });
    }

    expect(await prisma.userAgent.count()).toBe(agentsBefore);
    expect(putCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });
});
