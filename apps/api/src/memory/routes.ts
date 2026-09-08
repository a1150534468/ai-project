import { getPrisma } from "@ai-assistant/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  type MemoryShape,
  type MemoryType,
  memoryTextLength,
  sanitizeMemoryShape,
} from "./memory-types.js";

type RequestWithUser = FastifyRequest & { userId?: string };
type ActiveUser = { userId: string; memoryEnabled: boolean };

async function requireActiveUser(req: FastifyRequest, reply: FastifyReply): Promise<ActiveUser | null> {
  const userId = (req as RequestWithUser).userId;
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const account = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { memoryEnabled: true, bannedAt: true },
  });
  if (!account) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  if (account.bannedAt) {
    reply.code(403).send({ error: "账号已被封禁" });
    return null;
  }
  return { userId, memoryEnabled: account.memoryEnabled };
}

function emptyTypeCounts(): Record<MemoryType, number> {
  return Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<MemoryType, number>;
}

function countTypes(nodes: readonly { type: MemoryType }[]): Record<MemoryType, number> {
  return nodes.reduce((counts, node) => {
    counts[node.type] += 1;
    return counts;
  }, emptyTypeCounts());
}

function parseEdit(body: unknown): MemoryShape | null {
  if (typeof body !== "object" || body === null) return null;
  const input = body as Record<string, unknown>;
  if (typeof input.title !== "string" || typeof input.text !== "string") return null;
  const title = input.title.normalize("NFKC").trim();
  const text = input.text.normalize("NFKC").trim();
  if (!title || !text || memoryTextLength(title) > 40 || memoryTextLength(text) > 2000) return null;
  return sanitizeMemoryShape({ ...input, title, text });
}

async function vectorForChangedText(before: string, after: string): Promise<number[] | null> {
  if (before === after) return null;
  return (await embed(loadEmbeddingConfig(), after)).vector;
}

export async function memoryRoutes(app: FastifyInstance) {
  app.get<{ Reply: unknown }>("/api/memory", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    try {
      return { success: true, data: await listMemory(account.userId) };
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: "Failed to list memories" });
    }
  });

  app.get<{ Reply: unknown }>("/api/memory/settings", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    const enabled = account.memoryEnabled;
    return { success: true, data: { enabled, memoryEnabled: enabled } };
  });

  app.get<{ Reply: unknown }>("/api/memory/galaxy", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    try {
      const nodes = await listMemory(account.userId);
      return {
        success: true,
        data: {
          enabled: account.memoryEnabled,
          stats: { total: nodes.length, byType: countTypes(nodes) },
          nodes,
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: "Failed to load memory galaxy" });
    }
  });

  app.get<{ Querystring: { q?: string }; Reply: unknown }>("/api/memory/search", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    const raw = (req.query as { q?: unknown }).q;
    if (raw === undefined || raw === "") return { success: true, data: { hits: [] } };
    if (typeof raw !== "string" || memoryTextLength(raw) > 2000) {
      return reply.code(400).send({ error: "Invalid search query" });
    }
    const query = raw.trim();
    if (!query) return { success: true, data: { hits: [] } };

    try {
      const hits = await search(loadEmbeddingConfig(), account.userId, query);
      try {
        await touchMemories(account.userId, hits.map(({ id }) => id));
      } catch (error) {
        app.log.error(error);
      }
      return { success: true, data: { hits } };
    } catch (error) {
      app.log.error(error);
      // 搜索不可用不应拖垮记忆页；把它降级为本次没有匹配项。
      return { success: true, data: { hits: [] } };
    }
  });

  app.delete<{ Params: { id?: string }; Reply: unknown }>("/api/memory/:id", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: "Missing id" });
    try {
      await deleteMemory(account.userId, id);
      return { success: true };
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: "Failed to delete memory" });
    }
  });

  app.patch<{ Body: { enabled?: boolean }; Reply: unknown }>("/api/memory/toggle", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "Missing enabled" });
    try {
      await getPrisma().user.update({
        where: { id: account.userId },
        data: { memoryEnabled: enabled },
      });
      return { success: true, data: { memoryEnabled: enabled } };
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: "Failed to update memory setting" });
    }
  });

  app.patch<{ Params: { id?: string }; Body: unknown; Reply: unknown }>("/api/memory/:id", async (req, reply) => {
    const account = await requireActiveUser(req, reply);
    if (!account) return;
    const id = (req.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: "Missing id" });
    const edit = parseEdit(req.body);
    if (!edit) return reply.code(400).send({ error: "Invalid memory payload" });

    try {
      const existing = await getMemory(account.userId, id);
      if (!existing) return reply.code(404).send({ error: "Memory not found" });
      // embedding 非空列没有「暂时不可搜」状态；正文变了却保留旧向量会永久错召回。
      const vector = await vectorForChangedText(existing.text, edit.text);
      const outcome = await withUserMemoryTransaction(account.userId, (store) =>
        store.update(id, existing, edit, vector, {}));
      if (outcome.kind === "missing") return reply.code(404).send({ error: "Memory not found" });
      if (outcome.kind === "conflict") return reply.code(409).send({ error: "Memory changed" });
      return { success: true, data: outcome.record };
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: "Failed to update memory" });
    }
  });
}
