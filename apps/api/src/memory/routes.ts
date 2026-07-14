import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { embed, loadEmbeddingConfig } from "./embedding-client.js";
import { search } from "./memory-service.js";
import {
  deleteMemory,
  listMemory,
  touchMemories,
  updateMemory,
} from "./memory-store.js";
import { MEMORY_TYPES, sanitizeMemoryShape } from "./memory-types.js";

type AuthenticatedRequest = FastifyRequest & { userId?: string };

function getUserId(req: FastifyRequest): string | undefined {
  return (req as AuthenticatedRequest).userId;
}

function invalidMemoryPayload(reply: FastifyReply) {
  return reply.code(400).send({ error: "Invalid memory payload" });
}

async function getMemoryEnabled(userId: string): Promise<boolean> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { memoryEnabled: true },
  });
  return user?.memoryEnabled ?? true;
}

export async function memoryRoutes(app: FastifyInstance) {
  // GET /api/memory - 列表
  app.get<{ Reply: unknown }>("/api/memory", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    try {
      const memories = await listMemory(userId);
      return { success: true, data: memories };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to list memories" });
    }
  });

  app.get<{ Reply: unknown }>("/api/memory/settings", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    try {
      const enabled = await getMemoryEnabled(userId);
      return { success: true, data: { enabled, memoryEnabled: enabled } };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to get memory setting" });
    }
  });

  app.get<{ Reply: unknown }>("/api/memory/galaxy", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    try {
      const [enabled, nodes] = await Promise.all([
        getMemoryEnabled(userId),
        listMemory(userId),
      ]);
      const byType = Object.fromEntries(
        MEMORY_TYPES.map((type) => [type, 0]),
      ) as Record<(typeof MEMORY_TYPES)[number], number>;

      for (const node of nodes) {
        byType[node.type] += 1;
      }

      return {
        success: true,
        data: {
          enabled,
          stats: {
            total: nodes.length,
            byType,
          },
          nodes,
        },
      };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to load memory galaxy" });
    }
  });

  // GET /api/memory/search?q=... - 搜索
  app.get<{ Querystring: { q?: string }; Reply: unknown }>("/api/memory/search", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const q = (req.query as { q?: string }).q ?? "";
    if (!q.trim()) return { success: true, data: { hits: [] } };

    try {
      const cfg = loadEmbeddingConfig();
      const hits = await search(cfg, userId, q);
      try {
        await touchMemories(userId, hits.map((hit) => hit.id));
      } catch (err) {
        app.log.error(err);
      }
      return { success: true, data: { hits } };
    } catch (err) {
      app.log.error(err);
      // 降级：搜索失败返回空列表
      return { success: true, data: { hits: [] } };
    }
  });

  // DELETE /api/memory/:id - 删除
  app.delete<{ Params: { id?: string }; Reply: unknown }>("/api/memory/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const id = (req.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: "Missing id" });

    try {
      await deleteMemory(userId, id);
      return { success: true };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to delete memory" });
    }
  });

  // PATCH /api/memory/toggle - 开关
  app.patch<{ Body: { enabled?: boolean }; Reply: unknown }>("/api/memory/toggle", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const body = req.body as { enabled?: boolean } | undefined;
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "Missing enabled" });
    }
    const enabled = body.enabled;

    try {
      const prisma = getPrisma();
      await prisma.user.update({
        where: { id: userId },
        data: { memoryEnabled: enabled },
      });
      return { success: true, data: { memoryEnabled: enabled } };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to update memory setting" });
    }
  });

  app.patch<{ Params: { id?: string }; Body: unknown; Reply: unknown }>("/api/memory/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const id = (req.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: "Missing id" });

    const payload = req.body;
    if (typeof payload !== "object" || payload === null) {
      return invalidMemoryPayload(reply);
    }
    const input = payload as Record<string, unknown>;

    const rawTitle = typeof input.title === "string"
      ? input.title.normalize("NFKC").trim()
      : null;
    const rawText = typeof input.text === "string"
      ? input.text.normalize("NFKC").trim()
      : "";

    if (
      rawTitle === null
      || rawTitle.length === 0
      || rawTitle.length > 40
      || rawText.length === 0
      || rawText.length > 2000
    ) {
      return invalidMemoryPayload(reply);
    }

    const shape = sanitizeMemoryShape(input);
    if (!shape) {
      return invalidMemoryPayload(reply);
    }

    try {
      const existing = (await listMemory(userId)).find((memory) => memory.id === id);
      if (!existing) {
        return reply.code(404).send({ error: "Memory not found" });
      }

      let embeddingVector: number[] | null = null;
      let metadata: Record<string, boolean> = {};

      if (shape.text !== existing.text) {
        try {
          const cfg = loadEmbeddingConfig();
          const result = await embed(cfg, shape.text);
          embeddingVector = result.vector;
        } catch (err) {
          app.log.error(err);
          metadata = { needsEmbeddingRebuild: true };
        }
      }

      await updateMemory(userId, id, shape, embeddingVector, metadata);

      return {
        success: true,
        data: {
          ...existing,
          ...shape,
        },
      };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to update memory" });
    }
  });
}
