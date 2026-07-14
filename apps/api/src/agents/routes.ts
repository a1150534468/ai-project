import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getPrisma, getRedis } from "@ai-assistant/db";
import { generateCustomAgent, listCustomAgents, publicPresetAgents, renameAgent, deleteAgentCascade, regenerateAgentAvatar, agentAvatarUrlOf, setAgentAvatarUrl, avatarPublicUrl } from "./service.js";
import { consumeAvatarQuota } from "./ratelimit.js";
import { normalizeAvatarImage, AvatarImageError, AVATAR_MIME } from "./image.js";
import { makeS3, loadS3Config, putObject, deleteObject } from "../storage/s3.js";

const generateSchema = z.object({
  requirement: z.string().trim().min(2).max(2000),
});

const renameSchema = z.object({ name: z.string().trim().min(1).max(40) });

export interface AvatarStorage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface AgentRoutesOpts {
  redis?: Redis;
  storage?: AvatarStorage;
}

export async function agentRoutes(app: FastifyInstance, opts: AgentRoutesOpts = {}) {
  const prisma = getPrisma();
  const redis = opts.redis ?? getRedis();

  let cachedStorage: AvatarStorage | null = null;
  function defaultStorage(): AvatarStorage {
    const s3 = makeS3(loadS3Config());
    return {
      put: (key, body, mime) => putObject(s3, key, body, mime, { acl: "public-read" }),
      remove: (key) => deleteObject(s3, key),
    };
  }
  const storage = () => opts.storage ?? (cachedStorage ??= defaultStorage());

  app.get("/api/agents", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    return {
      success: true,
      data: {
        presets: publicPresetAgents(),
        custom: await listCustomAgents(prisma, userId),
      },
    };
  });

  app.post("/api/agents/generate", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      return { success: true, data: await generateCustomAgent(prisma, userId, parsed.data.requirement) };
    } catch (err) {
      req.log.error({ err }, "generate custom agent failed");
      return reply.code(502).send({ error: "智能体创建失败，请稍后重试" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const ok = await renameAgent(prisma, userId, req.params.id, parsed.data.name);
    if (!ok) return reply.code(404).send({ error: "智能体不存在" });
    return { success: true, data: null };
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const deleted = await deleteAgentCascade(prisma, userId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: "智能体不存在" });
    if (deleted.avatarUrl) {
      void storage()
        .remove(deleted.avatarUrl)
        .catch((err) => req.log.warn({ err }, "delete avatar object failed"));
    }
    return { success: true, data: null };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/avatar/regenerate", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!(await consumeAvatarQuota(redis, userId))) return reply.code(429).send({ error: "操作过于频繁，请稍后再试" });
    const result = await regenerateAgentAvatar(prisma, userId, req.params.id);
    if (!result) return reply.code(404).send({ error: "智能体不存在" });
    return { success: true, data: result };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/avatar/upload", async (req, reply) => {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    if (!(await consumeAvatarQuota(redis, userId))) return reply.code(429).send({ error: "操作过于频繁，请稍后再试" });

    const existing = await agentAvatarUrlOf(prisma, userId, req.params.id);
    if (!existing) return reply.code(404).send({ error: "智能体不存在" });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "缺少文件" });
    const raw = await data.toBuffer();

    let webp: Buffer;
    try {
      webp = await normalizeAvatarImage(raw);
    } catch (err) {
      if (err instanceof AvatarImageError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const key = `agent-avatars/${userId}/${req.params.id}/${Date.now()}.webp`;
    await storage().put(key, webp, AVATAR_MIME);
    await setAgentAvatarUrl(prisma, userId, req.params.id, key);

    if (existing.avatarUrl && existing.avatarUrl !== key) {
      void storage()
        .remove(existing.avatarUrl)
        .catch((err) => req.log.warn({ err }, "delete old avatar failed"));
    }
    return { success: true, data: { avatarUrl: avatarPublicUrl(key) } };
  });
}
