import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getPrisma } from "@ai-assistant/db";
import { buildServer } from "../server.js";
import { signToken } from "../auth/token.js";
import { generateUniqueUid } from "../auth/uid.js";

vi.mock("@ai-assistant/billing", () => ({
  createBillingClient: vi.fn(() => ({
    chargeResource: vi.fn().mockResolvedValue({ charged: 1 }),
    settleVideoResource: vi.fn().mockResolvedValue({ settled: 1 }),
    refundResource: vi.fn().mockResolvedValue({ success: true }),
  })),
  InsufficientBalanceError: class extends Error {},
}));
vi.mock("../storage/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../storage/s3.js")>("../storage/s3.js");
  return { ...actual, makeS3: vi.fn(() => ({ client: { send: vi.fn().mockResolvedValue({}) }, bucket: "t" })), putObject: vi.fn(), getObject: vi.fn() };
});
vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn(),
}));
vi.mock("croner", () => ({
  croner: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(),
}));

const prisma = getPrisma();
let app: Awaited<ReturnType<typeof buildServer>>;
let auth = ""; let userId = "";

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "x".repeat(32);
  process.env.ADMIN_SESSION_SECRET ??= "y".repeat(32);
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.LLM_BASE_URL ??= "http://localhost:9999";
  process.env.LLM_API_KEY ??= "test-key";
  process.env.SKYHUMAN_API_TOKEN ??= "sk-test";
  process.env.SKYHUMAN_CALLBACK_SECRET ??= "cbsecret";
  process.env.MIMO_API_KEY ??= "mk-test";
  process.env.S3_ENDPOINT ??= "http://localhost:9000"; process.env.S3_BUCKET ??= "t";
  process.env.S3_ACCESS_KEY ??= "a"; process.env.S3_SECRET_KEY ??= "b"; process.env.BILLING_BASE_URL ??= "http://localhost:1";
  process.env.BILLING_INTERNAL_TOKEN ??= "t"; process.env.EMBEDDING_MODEL ??= "test-embedding-model";
  const uid = await generateUniqueUid(async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })));
  const u = await prisma.user.create({ data: { uid, username: `dub_${Date.now()}`, passwordHash: "x" } });
  userId = u.id; auth = `Bearer ${signToken(userId, process.env.SESSION_SECRET!)}`;
  app = await buildServer(); await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.skyhumanTask.deleteMany({ where: { userId } });
  await prisma.dubProject.deleteMany({ where: { userId } });
  await prisma.avatar.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("dub 路由", () => {
  /**
   * P1.1 把这 22 个路由的内联 401 守卫换成了逐路由 `{ preHandler: requireUser }`。
   *
   * 本文件不能挂插件级钩子：POST /skyhuman/callback 是供应商回调，带不了用户票据，
   * 挂上去成片就永远回不来。所以守卫一条一条挂。
   *
   * 代价是钉不住：插件级钩子一条断言就锁整个文件，逐路由 preHandler 各自独立 ——
   * 删掉某一条的 preHandler，其它条的测试照样绿。原先只有 5 条散落的 401 单测
   * （avatars / analyze / rewrite / projects / pricing），剩下 17 条谁的守卫被删
   * 都不会有人发现。那 5 条做的事跟这里的循环完全一样，合并进来。
   *
   * 公开回调不用在这儿反证：下面 "回调 secret 错误 403" / "正确 200 received"
   * 两条已经证明它未登录也能进 handler。
   */
  it("未登录时 22 个受保护路由逐条返回 401", async () => {
    const cases: ReadonlyArray<{
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/api/workflow/dub/tts/voices" },
      { method: "POST", url: "/api/workflow/dub/tts", payload: { mode: "preset", text: "x" } },
      { method: "GET", url: "/api/workflow/dub/pricing" },
      { method: "GET", url: "/api/workflow/dub/bgm" },
      { method: "POST", url: "/api/workflow/dub/bgm/upload", payload: {} },
      { method: "POST", url: "/api/workflow/dub/projects", payload: { title: "x" } },
      { method: "GET", url: "/api/workflow/dub/projects" },
      { method: "GET", url: "/api/workflow/dub/projects/p1" },
      { method: "PATCH", url: "/api/workflow/dub/projects/p1", payload: { script: "x" } },
      { method: "DELETE", url: "/api/workflow/dub/projects/p1" },
      { method: "POST", url: "/api/workflow/dub/projects/p1/generate" },
      { method: "POST", url: "/api/workflow/dub/projects/p1/remix" },
      { method: "POST", url: "/api/workflow/dub/analyze", payload: {} },
      { method: "POST", url: "/api/workflow/dub/parse", payload: { text: "x" } },
      { method: "POST", url: "/api/workflow/dub/analyze-parsed", payload: { objectKey: "x" } },
      { method: "POST", url: "/api/workflow/dub/rewrite", payload: { text: "x" } },
      { method: "GET", url: "/api/workflow/dub/avatars" },
      { method: "POST", url: "/api/workflow/dub/avatars", payload: {} },
      { method: "PATCH", url: "/api/workflow/dub/avatars/a1", payload: { favorite: true } },
      { method: "DELETE", url: "/api/workflow/dub/avatars/a1" },
      { method: "POST", url: "/api/workflow/dub/video/generate", payload: {} },
      { method: "GET", url: "/api/workflow/dub/tasks/t1" },
    ];
    expect(cases).toHaveLength(22);
    for (const one of cases) {
      const r = await app.inject(one);
      expect(r.statusCode, `${one.method} ${one.url}`).toBe(401);
      expect(r.json(), `${one.method} ${one.url}`).toEqual({ error: "未登录" });
    }
  });
  it("GET /avatars 已登录返回本人形象", async () => {
    await prisma.avatar.create({ data: { userId, avatarCode: "av_1", title: "我" } });
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/avatars", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: Array<{ avatarCode: string }> }).data.some((a) => a.avatarCode === "av_1")).toBe(true);
  });
  it("GET /tasks/:id 越权/不存在 404", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/tasks/nonexist", headers: { authorization: auth } });
    expect(r.statusCode).toBe(404);
  });
  it("PATCH /avatars/:id 收藏本人形象", async () => {
    const a = await prisma.avatar.create({ data: { userId, avatarCode: "av_fav", title: "x" } });
    const r = await app.inject({ method: "PATCH", url: `/api/workflow/dub/avatars/${a.id}`, headers: { authorization: auth }, payload: { favorite: true } });
    expect(r.statusCode).toBe(200);
    const updated = await prisma.avatar.findUnique({ where: { id: a.id } });
    expect(updated?.isFavorite).toBe(true);
  });
  it("回调 secret 错误 403", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/skyhuman/callback?secret=wrong", payload: { task_id: "p1" } });
    expect(r.statusCode).toBe(403);
  });
  it("回调 secret 正确 200 received", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/skyhuman/callback?secret=cbsecret", payload: { task_id: "nomatch" } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { received: boolean }).received).toBe(true);
  });
  it("GET /tts/voices 返回预置音色", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/tts/voices", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: Array<{ id: string }> }).data.some((v) => v.id === "冰糖")).toBe(true);
  });
  it("POST /tts 缺 mode 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/tts", headers: { authorization: auth }, payload: { text: "你好" } });
    expect(r.statusCode).toBe(400);
  });
  it("POST /tts preset 缺音色 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/tts", headers: { authorization: auth }, payload: { mode: "preset", text: "你好" } });
    expect(r.statusCode).toBe(400);
  });
  it("POST /rewrite 空文案 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/rewrite", headers: { authorization: auth }, payload: { text: "  " } });
    expect(r.statusCode).toBe(400);
  });
  it("POST /rewrite 超长文案 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/rewrite", headers: { authorization: auth }, payload: { text: "a".repeat(20001) } });
    expect(r.statusCode).toBe(400);
  });

  it("项目 创建→查询→改字段→删除 全链路", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: { title: "测试口播" } });
    expect(c.statusCode).toBe(200);
    const id = (c.json() as { data: { id: string; title: string } }).data.id;

    const g = await app.inject({ method: "GET", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
    expect(g.statusCode).toBe(200);
    expect((g.json() as { data: { title: string } }).data.title).toBe("测试口播");

    const p = await app.inject({ method: "PATCH", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth }, payload: { script: "洗后文案" } });
    expect(p.statusCode).toBe(200);
    expect((await prisma.dubProject.findUnique({ where: { id } }))?.script).toBe("洗后文案");

    const d = await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
    expect(d.statusCode).toBe(200);
  });
  it("GET /projects/:id 不存在 404", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/projects/nope", headers: { authorization: auth } });
    expect(r.statusCode).toBe(404);
  });
  it("generate 缺配音 400", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: {} });
    const id = (c.json() as { data: { id: string } }).data.id;
    const r = await app.inject({ method: "POST", url: `/api/workflow/dub/projects/${id}/generate`, headers: { authorization: auth } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain("配音");
    await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
  });
  it("generate 已在成片中 409（防重复下单二次扣费）", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: {} });
    const id = (c.json() as { data: { id: string } }).data.id;
    await prisma.dubProject.update({ where: { id }, data: { stage: "generating", audioObjectKey: "k", avatarId: "a" } });
    const r = await app.inject({ method: "POST", url: `/api/workflow/dub/projects/${id}/generate`, headers: { authorization: auth } });
    expect(r.statusCode).toBe(409);
    await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
  });
  it("remix 尚无成片 400", async () => {
    const c = await app.inject({ method: "POST", url: "/api/workflow/dub/projects", headers: { authorization: auth }, payload: {} });
    const id = (c.json() as { data: { id: string } }).data.id;
    const r = await app.inject({ method: "POST", url: `/api/workflow/dub/projects/${id}/remix`, headers: { authorization: auth } });
    expect(r.statusCode).toBe(400);
    await app.inject({ method: "DELETE", url: `/api/workflow/dub/projects/${id}`, headers: { authorization: auth } });
  });
  it("GET /pricing 返回五项（billing mock 无 listResourcePrices → 全 disabled）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/pricing", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    const d = (r.json() as { data: Record<string, { enabled: boolean }> }).data;
    expect(Object.keys(d).sort()).toEqual(["analyzeVideoSec", "avatarClone", "parseVideo", "ttsChar", "videoSec"]);
    expect(d.ttsChar.enabled).toBe(false);
  });
  it("GET /bgm 返回预制列表", async () => {
    const r = await app.inject({ method: "GET", url: "/api/workflow/dub/bgm", headers: { authorization: auth } });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray((r.json() as { data: unknown[] }).data)).toBe(true);
  });
  it("POST /analyze-parsed 越权访问他人资源 403", async () => {
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/analyze-parsed", headers: { authorization: auth }, payload: { objectKey: "dub/parsed/OTHER_USER/x.mp4" } });
    expect(r.statusCode).toBe(403);
  });
  it("POST /parse 没有链接 400", async () => {
    vi.stubEnv("DUB_PARSE_CLIENT_ID", "x");
    vi.stubEnv("DUB_PARSE_SECRET_KEY", "y");
    const r = await app.inject({ method: "POST", url: "/api/workflow/dub/parse", headers: { authorization: auth }, payload: { text: "没有任何链接" } });
    expect(r.statusCode).toBe(400);
  });
});
