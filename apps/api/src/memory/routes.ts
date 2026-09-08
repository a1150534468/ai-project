import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { embed, loadEmbeddingConfig } from "./embedding-client.js";
import { search } from "./memory-service.js";
import {
  deleteMemory,
  getMemory,
  listMemory,
  touchMemories,
  withUserMemoryTransaction,
} from "./memory-store.js";
import {
  MEMORY_TYPES,
  memoryTextLength,
  sanitizeMemoryShape,
} from "./memory-types.js";

type AuthenticatedRequest = FastifyRequest & { userId?: string };

function getUserId(req: FastifyRequest): string | undefined {
  return (req as AuthenticatedRequest).userId;
}

type ActiveUser = { memoryEnabled: boolean; bannedAt: Date | null };

async function activeUser(req: FastifyRequest, reply: FastifyReply): Promise<ActiveUser | null> {
  const userId = getUserId(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { memoryEnabled: true, bannedAt: true },
  });
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  if (user.bannedAt) {
    reply.code(403).send({ error: "账号已被封禁" });
    return null;
  }
  return user;
}

function invalidMemoryPayload(reply: FastifyReply) {
  return reply.code(400).send({ error: "Invalid memory payload" });
}

export async function memoryRoutes(app: FastifyInstance) {
  // GET /api/memory - 列表
  app.get<{ Reply: unknown }>("/api/memory", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

    try {
      const memories = await listMemory(userId);
      return { success: true, data: memories };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to list memories" });
    }
  });

  app.get<{ Reply: unknown }>("/api/memory/settings", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

    try {
      const enabled = user.memoryEnabled;
      return { success: true, data: { enabled, memoryEnabled: enabled } };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to get memory setting" });
    }
  });

  app.get<{ Reply: unknown }>("/api/memory/galaxy", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

    try {
      const nodes = await listMemory(userId);
      const enabled = user.memoryEnabled;
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
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

    const rawQuery = (req.query as { q?: unknown }).q;
    if (rawQuery === undefined || rawQuery === "") return { success: true, data: { hits: [] } };
    if (typeof rawQuery !== "string" || memoryTextLength(rawQuery) > 2000) {
      return reply.code(400).send({ error: "Invalid search query" });
    }
    const q = rawQuery.trim();
    if (!q) return { success: true, data: { hits: [] } };

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
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

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
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

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
    const user = await activeUser(req, reply);
    if (!user) return;
    const userId = getUserId(req)!;

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
      || memoryTextLength(rawTitle) > 40
      || rawText.length === 0
      || memoryTextLength(rawText) > 2000
    ) {
      return invalidMemoryPayload(reply);
    }

    const shape = sanitizeMemoryShape(input);
    if (!shape) {
      return invalidMemoryPayload(reply);
    }

    try {
      const existing = await getMemory(userId, id);
      if (!existing) return reply.code(404).send({ error: "Memory not found" });

      let vector: number[] | null = null;
      if (shape.text !== existing.text) {
        // embedding 非空列没有「暂时不可搜」状态；写新正文却留旧向量会永久错召回，所以失败就不写。
        const cfg = loadEmbeddingConfig();
        vector = (await embed(cfg, shape.text)).vector;
      }

      const result = await withUserMemoryTransaction(userId, (store) =>
        store.update(id, existing, shape, vector, {}));
      if (result.kind === "missing") return reply.code(404).send({ error: "Memory not found" });
      if (result.kind === "conflict") return reply.code(409).send({ error: "Memory changed" });
      return { success: true, data: result.record };
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "Failed to update memory" });
    }
  });
}
