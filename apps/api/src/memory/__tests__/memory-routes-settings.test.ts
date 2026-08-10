import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "../../auth/token.js";
import type { MemoryHit } from "../memory-store.js";
import type { MemoryRecord } from "../memory-types.js";

vi.mock("@ai-assistant/db", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../embedding-client.js", () => ({
  loadEmbeddingConfig: vi.fn(() => ({
    baseURL: "http://embedding.test",
    apiKey: "[REDACTED]",
    model: "embedding-model",
  })),
}));

vi.mock("../memory-service.js", () => ({ search: vi.fn() }));
vi.mock("../memory-store.js", () => ({ deleteMemory: vi.fn(), listMemory: vi.fn(), touchMemories: vi.fn(), updateMemory: vi.fn() }));

const { getPrisma } = await import("@ai-assistant/db");
const memoryService = await import("../memory-service.js");
const memoryStore = await import("../memory-store.js");
const { memoryRoutes } = await import("../routes.js");

const userId = "user-memory-route-settings";
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

function createPrismaMock(memoryEnabled = true) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ memoryEnabled }),
      update: vi.fn(),
    },
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const verified = verifyToken(auth.slice(7), process.env.SESSION_SECRET!);
      if (verified) {
        req.userId = verified;
      }
    }
  });
  await app.register(memoryRoutes);
  await app.ready();
  return app;
}

describe("memory routes settings/search resilience", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "x".repeat(32);
    process.env.EMBEDDING_MODEL = "embedding-model";
    vi.clearAllMocks();
    vi.mocked(getPrisma).mockImplementation(
      () => createPrismaMock() as unknown as ReturnType<typeof getPrisma>,
    );
  });

  it("GET /api/memory/settings returns enabled state and requires auth", async () => {
    vi.mocked(getPrisma).mockImplementation(
      () => createPrismaMock(true) as unknown as ReturnType<typeof getPrisma>,
    );
    const app = await buildApp();

    const unauthorized = await app.inject({ method: "GET", url: "/api/memory/settings" });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/memory/settings",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({
      success: true,
      data: { enabled: true, memoryEnabled: true },
    });

    await app.close();
  });

  it("GET /api/memory/search keeps hits when touchMemories fails", async () => {
    const app = await buildApp();
    const hits: MemoryHit[] = [
      { id: "m1", ...baseRecord, score: 0.8 },
      { id: "m2", ...baseRecord, score: 0.6 },
    ];
    vi.mocked(memoryService.search).mockResolvedValue(hits);
    vi.mocked(memoryStore.touchMemories).mockRejectedValue(new Error("touch failed"));

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=typescript",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
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
