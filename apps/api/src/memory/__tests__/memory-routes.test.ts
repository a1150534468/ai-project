import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "../../auth/token.js";
import type { MemoryHit, UserMemoryTransaction } from "../memory-store.js";
import type { MemoryRecord } from "../memory-types.js";

vi.mock("@ai-assistant/db", () => ({ getPrisma: vi.fn() }));
vi.mock("../embedding-client.js", () => ({
  embed: vi.fn(),
  loadEmbeddingConfig: vi.fn(() => ({ baseURL: "http://embedding.test", apiKey: "key", model: "embedding-model" })),
}));
vi.mock("../memory-service.js", () => ({ search: vi.fn() }));
vi.mock("../memory-store.js", () => ({
  deleteMemory: vi.fn(),
  getMemory: vi.fn(),
  listMemory: vi.fn(),
  touchMemories: vi.fn(),
  withUserMemoryTransaction: vi.fn(),
}));

const { getPrisma } = await import("@ai-assistant/db");
const embeddingClient = await import("../embedding-client.js");
const memoryService = await import("../memory-service.js");
const memoryStore = await import("../memory-store.js");
const { memoryRoutes } = await import("../routes.js");

const userId = "user-memory-routes";
const token = signToken(userId, "x".repeat(32));
const base = {
  title: "默认标题",
  text: "默认记忆",
  type: "OTHER" as const,
  importance: 50,
  tags: [],
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  lastUsedAt: null,
  usedCount: 0,
};
const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: "memory-1", ...base, ...overrides });

let prisma: ReturnType<typeof prismaMock>;
let tx: UserMemoryTransaction;

function prismaMock(user: { memoryEnabled: boolean; bannedAt: Date | null } | null = { memoryEnabled: true, bannedAt: null }) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      update: vi.fn(async ({ data }: { data: { memoryEnabled: boolean } }) => ({ id: userId, ...data })),
    },
  };
}

async function app() {
  const instance = Fastify();
  instance.decorateRequest("userId", "");
  instance.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) req.userId = verifyToken(auth.slice(7), process.env.SESSION_SECRET!) ?? "";
  });
  await instance.register(memoryRoutes);
  await instance.ready();
  return instance;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "x".repeat(32);
  vi.clearAllMocks();
  prisma = prismaMock();
  vi.mocked(getPrisma).mockReturnValue(prisma as never);
  tx = {
    get: vi.fn(),
    list: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  vi.mocked(memoryStore.withUserMemoryTransaction).mockImplementation(async (_userId, work) => work(tx));
});

const previousSessionSecret = process.env.SESSION_SECRET;

afterEach(() => {
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
});

describe("memory routes", () => {
  it("六条路由都拒绝未登录、已删除和封禁用户，且没有副作用", async () => {
    const instance = await app();
    const cases = [
      ["GET", "/api/memory"],
      ["GET", "/api/memory/settings"],
      ["GET", "/api/memory/galaxy"],
      ["GET", "/api/memory/search?q=x"],
      ["PATCH", "/api/memory/toggle", { enabled: false }],
      ["PATCH", "/api/memory/m1", { title: "t", text: "text" }],
      ["DELETE", "/api/memory/m1"],
    ] as const;

    for (const [method, url, payload] of cases) {
      expect((await instance.inject({ method, url, payload })).statusCode).toBe(401);
    }
    prisma.user.findUnique.mockResolvedValueOnce(null);
    expect((await instance.inject({ method: "GET", url: "/api/memory", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    prisma.user.findUnique.mockResolvedValueOnce({ memoryEnabled: true, bannedAt: new Date() });
    expect((await instance.inject({ method: "GET", url: "/api/memory", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    expect(memoryStore.listMemory).not.toHaveBeenCalled();
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    await instance.close();
  });

  it("settings 与 galaxy 复用已验证用户的开关并返回五类统计", async () => {
    vi.mocked(memoryStore.listMemory).mockResolvedValue([
      record({ id: "core", type: "CORE" }),
      record({ id: "temp", type: "TEMPORARY" }),
    ]);
    const instance = await app();
    const headers = { authorization: `Bearer ${token}` };

    expect((await instance.inject({ method: "GET", url: "/api/memory/settings", headers })).json()).toEqual({
      success: true,
      data: { enabled: true, memoryEnabled: true },
    });
    expect((await instance.inject({ method: "GET", url: "/api/memory/galaxy", headers })).json()).toEqual({
      success: true,
      data: {
        enabled: true,
        stats: { total: 2, byType: { CORE: 1, PERMANENT: 0, TEMPORARY: 1, KNOWLEDGE: 0, OTHER: 0 } },
        nodes: [expect.objectContaining({ id: "core" }), expect.objectContaining({ id: "temp" })],
      },
    });
    await instance.close();
  });

  it("重复 q 返回 400，空查询仍是 200 空命中", async () => {
    const instance = await app();
    const headers = { authorization: `Bearer ${token}` };
    expect((await instance.inject({ method: "GET", url: "/api/memory/search?q=a&q=b", headers })).statusCode).toBe(400);
    expect((await instance.inject({ method: "GET", url: "/api/memory/search?q=%20", headers })).json()).toEqual({
      success: true,
      data: { hits: [] },
    });
    expect(memoryService.search).not.toHaveBeenCalled();
    await instance.close();
  });

  it("已登录用户可以切换开关并幂等删除自己的记忆", async () => {
    const instance = await app();
    const headers = { authorization: `Bearer ${token}` };
    const toggled = await instance.inject({
      method: "PATCH",
      url: "/api/memory/toggle",
      headers,
      payload: { enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { memoryEnabled: false },
    });
    expect(toggled.json()).toEqual({ success: true, data: { memoryEnabled: false } });

    const deleted = await instance.inject({ method: "DELETE", url: "/api/memory/m1", headers });
    expect(deleted.statusCode).toBe(200);
    expect(memoryStore.deleteMemory).toHaveBeenCalledWith(userId, "m1");
    expect(deleted.json()).toEqual({ success: true });
    await instance.close();
  });

  it("搜索命中后递增使用次数，touch 失败也保留命中", async () => {
    const hits: MemoryHit[] = [
      { ...record({ id: "m1" }), score: 0.8 },
      { ...record({ id: "m2" }), score: 0.6 },
    ];
    vi.mocked(memoryService.search).mockResolvedValue(hits);
    vi.mocked(memoryStore.touchMemories).mockRejectedValue(new Error("touch failed"));
    const instance = await app();
    const response = await instance.inject({
      method: "GET",
      url: "/api/memory/search?q=typescript",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(memoryStore.touchMemories).toHaveBeenCalledWith(userId, ["m1", "m2"]);
    expect(response.json().data.hits).toHaveLength(2);
    await instance.close();
  });

  it("PATCH 只改显示字段时保留向量与 metadata，并返回真实落库行", async () => {
    const existing = record({ id: "m-edit", title: "旧标题", text: "相同正文", usedCount: 7 });
    const saved = { ...existing, title: "新标题", importance: 88 };
    vi.mocked(memoryStore.getMemory).mockResolvedValue(existing);
    vi.mocked(tx.update).mockResolvedValue({ kind: "updated", record: saved });
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH",
      url: "/api/memory/m-edit",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "新标题", text: "相同正文", type: "OTHER", importance: 88, tags: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalledWith(
      "m-edit",
      existing,
      expect.objectContaining({ title: "新标题", text: "相同正文" }),
      null,
      {},
    );
    expect(response.json().data).toMatchObject({ id: "m-edit", title: "新标题", usedCount: 7 });
    await instance.close();
  });

  it("PATCH 正文变化时先生成新向量；失败则一字不写", async () => {
    const existing = record({ id: "m-edit", text: "主题 A" });
    vi.mocked(memoryStore.getMemory).mockResolvedValue(existing);
    vi.mocked(embeddingClient.embed).mockRejectedValue(new Error("embedding failed"));
    const instance = await app();
    const response = await instance.inject({
      method: "PATCH",
      url: "/api/memory/m-edit",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "主题 B", text: "主题 B", type: "CORE", importance: 80, tags: [] },
    });
    expect(response.statusCode).toBe(500);
    expect(tx.update).not.toHaveBeenCalled();
    await instance.close();
  });

  it("PATCH 用 CAS 区分已经删除的 404 和并发修改的 409", async () => {
    const existing = record({ id: "m-edit" });
    vi.mocked(memoryStore.getMemory).mockResolvedValue(existing);
    const instance = await app();
    const options = {
      method: "PATCH" as const,
      url: "/api/memory/m-edit",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "标题", text: existing.text, type: "OTHER", importance: 50, tags: [] },
    };
    vi.mocked(tx.update).mockResolvedValueOnce({ kind: "missing" });
    expect((await instance.inject(options)).statusCode).toBe(404);
    vi.mocked(tx.update).mockResolvedValueOnce({ kind: "conflict" });
    expect((await instance.inject(options)).statusCode).toBe(409);
    await instance.close();
  });
});
