import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "../../auth/token.js";
import type { EmbedResult } from "../embedding-client.js";
import type { MemoryHit } from "../memory-store.js";
import type { MemoryRecord } from "../memory-types.js";

vi.mock("@yc/db", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../embedding-client.js", () => ({
  embed: vi.fn<(...args: readonly unknown[]) => Promise<EmbedResult>>(),
  loadEmbeddingConfig: vi.fn(() => ({
    baseURL: "http://embedding.test",
    apiKey: "[REDACTED]",
    model: "embedding-model",
  })),
}));

vi.mock("../memory-service.js", () => ({ search: vi.fn() }));
vi.mock("../memory-store.js", () => ({ deleteMemory: vi.fn(), listMemory: vi.fn(), touchMemories: vi.fn(), updateMemory: vi.fn() }));

const { getPrisma } = await import("@yc/db");
const embeddingClient = await import("../embedding-client.js");
const memoryService = await import("../memory-service.js");
const memoryStore = await import("../memory-store.js");
const { memoryRoutes } = await import("../routes.js");

const userId = "user-memory-routes";
const token = signToken(userId, "x".repeat(32));

const baseRecord = {
  title: "默认标题",
  text: "默认记忆",
  type: "OTHER",
  importance: 50,
  tags: [],
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  lastUsedAt: null,
  usedCount: 0,
} satisfies Omit<MemoryRecord, "id">;

const makeRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "memory-1",
  ...baseRecord,
  ...overrides,
});

type MockPrisma = { readonly user: { readonly findUnique: ReturnType<typeof vi.fn>; readonly update: ReturnType<typeof vi.fn> } };

function createPrismaMock(memoryEnabled = true) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ memoryEnabled }),
      update: vi.fn().mockImplementation(async ({ data }: { data: { memoryEnabled: boolean } }) => ({
        id: userId,
        memoryEnabled: data.memoryEnabled,
      })),
    },
  } satisfies MockPrisma;
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const verified = verifyToken(auth.slice(7), process.env.SESSION_SECRET!);
      if (verified) {
        (req as unknown as { userId: string }).userId = verified;
      }
    }
  });
  await app.register(memoryRoutes);
  await app.ready();
  return app;
}

describe("memory routes", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "x".repeat(32);
    process.env.EMBEDDING_MODEL = "embedding-model";
    vi.clearAllMocks();
    vi.mocked(getPrisma).mockImplementation(
      () => createPrismaMock() as unknown as ReturnType<typeof getPrisma>,
    );
  });

  afterEach(() => {
    delete process.env.EMBEDDING_MODEL;
  });

  it("GET /api/memory/galaxy returns enabled, stats and nodes", async () => {
    vi.mocked(getPrisma).mockImplementation(
      () => createPrismaMock(true) as unknown as ReturnType<typeof getPrisma>,
    );
    vi.mocked(memoryStore.listMemory).mockResolvedValue([
      makeRecord({ id: "m-core", type: "CORE" }),
      makeRecord({ id: "m-temp", type: "TEMPORARY" }),
    ]);

    const app = await buildApp();

    const unauthorized = await app.inject({ method: "GET", url: "/api/memory/galaxy" });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/galaxy",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        enabled: true,
        stats: {
          total: 2,
          byType: {
            CORE: 1,
            PERMANENT: 0,
            TEMPORARY: 1,
            KNOWLEDGE: 0,
            OTHER: 0,
          },
        },
        nodes: [
          expect.objectContaining({ id: "m-core", type: "CORE" }),
          expect.objectContaining({ id: "m-temp", type: "TEMPORARY" }),
        ],
      },
    });
    expect(memoryStore.listMemory).toHaveBeenCalledWith(userId);

    await app.close();
  });

  it("PATCH /api/memory/:id validates and updates memory", async () => {
    const app = await buildApp();
    vi.mocked(memoryStore.listMemory).mockResolvedValue([makeRecord({ id: "memory-123", text: "旧文本", type: "OTHER", importance: 40 })]);
    vi.mocked(embeddingClient.embed).mockResolvedValue({
      vector: [0.1, 0.2, 0.3],
      tokens: 12,
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/memory/memory-123",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "   " },
    });

    const missingTitle = await app.inject({
      method: "PATCH",
      url: "/api/memory/memory-123",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "只有文本，没有标题" },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Invalid memory payload" });
    expect(missingTitle.statusCode).toBe(400);
    expect(missingTitle.json()).toEqual({ error: "Invalid memory payload" });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/memory/memory-123",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "  更新标题  ",
        text: "新的记忆文本",
        type: "CORE",
        importance: 88,
        tags: ["标签1", "标签1", ""],
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(embeddingClient.embed).toHaveBeenCalledWith(
      expect.objectContaining({ model: "embedding-model" }),
      "新的记忆文本",
    );
    expect(memoryStore.updateMemory).toHaveBeenCalledWith(
      userId,
      "memory-123",
      {
        title: "更新标题",
        text: "新的记忆文本",
        type: "CORE",
        importance: 88,
        tags: ["标签1"],
      },
      [0.1, 0.2, 0.3],
      {},
    );
    expect(updated.json()).toEqual({
      success: true,
      data: expect.objectContaining({
        id: "memory-123",
        title: "更新标题",
        text: "新的记忆文本",
        type: "CORE",
        importance: 88,
        tags: ["标签1"],
      }),
    });

    await app.close();
  });

  it("PATCH /api/memory/:id falls back when embedding fails", async () => {
    const app = await buildApp();
    vi.mocked(memoryStore.listMemory).mockResolvedValue([makeRecord({ id: "memory-embedding", text: "旧文本" })]);
    vi.mocked(embeddingClient.embed).mockRejectedValue(new Error("embedding failed"));

    const response = await app.inject({
      method: "PATCH",
      url: "/api/memory/memory-embedding",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "降级标题",
        text: "需要重新构建向量",
        type: "KNOWLEDGE",
        importance: 77,
        tags: ["embed"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(memoryStore.updateMemory).toHaveBeenCalledWith(
      userId,
      "memory-embedding",
      {
        title: "降级标题",
        text: "需要重新构建向量",
        type: "KNOWLEDGE",
        importance: 77,
        tags: ["embed"],
      },
      null,
      { needsEmbeddingRebuild: true },
    );

    await app.close();
  });

  it("GET /api/memory/search touches hit usage counters", async () => {
    const app = await buildApp();
    const hits: MemoryHit[] = [{ ...makeRecord({ id: "m1" }), score: 0.8 }, { ...makeRecord({ id: "m2" }), score: 0.6 }];
    vi.mocked(memoryService.search).mockResolvedValue(hits);

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=typescript",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(memoryService.search).toHaveBeenCalledWith(
      expect.objectContaining({ model: "embedding-model" }),
      userId,
      "typescript",
    );
    expect(memoryStore.touchMemories).toHaveBeenCalledWith(userId, ["m1", "m2"]);
    expect(response.json()).toEqual({
      success: true,
      data: {
        hits: [
          expect.objectContaining({ id: "m1", createdAt: "2026-06-01T00:00:00.000Z", score: 0.8 }),
          expect.objectContaining({ id: "m2", createdAt: "2026-06-01T00:00:00.000Z", score: 0.6 }),
        ],
      },
    });

    await app.close();
  });
});
