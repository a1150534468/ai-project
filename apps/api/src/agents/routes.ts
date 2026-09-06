import { getPrisma, getRedis } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { requireUser } from "../auth/require-user.js";
import { deleteObject, loadS3Config, makeS3, putObject } from "../storage/s3.js";
import { AVATAR_MIME, AvatarImageError, normalizeAvatarImage } from "./image.js";
import { consumeAvatarQuota } from "./ratelimit.js";
import {
  agentAvatarUrlOf,
  avatarPublicUrl,
  deleteAgentCascade,
  generateCustomAgent,
  listCustomAgents,
  publicPresetAgents,
  regenerateAgentAvatar,
  renameAgent,
  setAgentAvatarUrl,
} from "./service.js";

/** 下限 2 个字：一个字的「需求」生成不出任何有意义的配置。上限 2000 是给模型的输入留余量。 */
const generateSchema = z.object({ requirement: z.string().trim().min(2).max(2000) });

/** 40 和 service.ts 里 `parseGeneratedAgent` 截名字的长度一致 —— 手改和模型生成得受同一个限制。 */
const renameSchema = z.object({ name: z.string().trim().min(1).max(40) });

/**
 * 头像文件的存放接口。
 *
 * 只抽了 put / remove 两个动作，是为了让测试能塞一个记录调用的假实现，
 * 不必为了跑一条上传用例去起 MinIO。
 */
export interface AvatarStorage {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface AgentRoutesOpts {
  redis?: Redis;
  storage?: AvatarStorage;
}

export async function agentRoutes(app: FastifyInstance, opts: AgentRoutesOpts = {}) {
  // 本文件 6 条路由全部要求登录，所以守卫挂在插件级而不是逐条挂。
  // 钩子和它保护的路由写在同一个文件里：测试单独注册这个插件时，守卫不会凭空消失，
  // 漏挂也就不可能表现为「测试全绿但线上没鉴权」。
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();
  const redis = opts.redis ?? getRedis();

  let cachedStorage: AvatarStorage | null = null;

  function defaultStorage(): AvatarStorage {
    const s3 = makeS3(loadS3Config());
    return {
      // public-read：头像要能被 <img> 直接引用，签名 URL 会过期。
      put: (key, body, mime) => putObject(s3, key, body, mime, { acl: "public-read" }),
      remove: (key) => deleteObject(s3, key),
    };
  }

  /**
   * **必须懒加载**：`loadS3Config()` 在没配 S3 的环境（本地、CI）会抛错，
   * 要是在注册插件时就调用，整个 api 都起不来 —— 而其余 5 条路由根本不需要对象存储。
   */
  const storage = () => opts.storage ?? (cachedStorage ??= defaultStorage());

  app.get("/api/agents", async (req) => ({
    success: true,
    data: {
      presets: publicPresetAgents(),
      custom: await listCustomAgents(prisma, req.userId),
    },
  }));

  app.post("/api/agents/generate", async (req, reply) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    try {
      return { success: true, data: await generateCustomAgent(prisma, req.userId, parsed.data.requirement) };
    } catch (err) {
      // 502 而不是 500：失败的是上游模型，不是我们。日志里留原始错误，回给用户的话不带细节。
      req.log.error({ err }, "generate custom agent failed");
      return reply.code(502).send({ error: "智能体创建失败，请稍后重试" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const renamed = await renameAgent(prisma, req.userId, req.params.id, parsed.data.name);
    // 别人的 Agent 也走这一条：service 层的条件带了 userId，所以「不是你的」和「不存在」同一个出口。
    if (!renamed) return reply.code(404).send({ error: "智能体不存在" });

    return { success: true, data: null };
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const deleted = await deleteAgentCascade(prisma, req.userId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: "智能体不存在" });

    // 删文件是 best-effort，故意不 await：库里已经删干净了，用户等的是这个。
    // 对象存储抽风只会留一个孤儿文件（浪费点空间），不该让这次删除看起来失败。
    if (deleted.avatarUrl) {
      void storage()
        .remove(deleted.avatarUrl)
        .catch((err) => req.log.warn({ err }, "delete avatar object failed"));
    }

    return { success: true, data: null };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/avatar/regenerate", async (req, reply) => {
    // 限流放在查存在性**之前**。顺序是有意的：先查再限流的话，攻击者可以用不同 id 反复试探，
    // 靠 404 和 429 的区别把「哪些 id 存在」枚举出来，而且每一次试探都真的花了模型的钱。
    if (!(await consumeAvatarQuota(redis, req.userId))) {
      return reply.code(429).send({ error: "操作过于频繁，请稍后再试" });
    }

    const result = await regenerateAgentAvatar(prisma, req.userId, req.params.id);
    if (!result) return reply.code(404).send({ error: "智能体不存在" });

    return { success: true, data: result };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/avatar/upload", async (req, reply) => {
    // 同上：额度先扣。上传这条路更值得这么做 —— 后面要读整个请求体、还要跑一次图片解码。
    if (!(await consumeAvatarQuota(redis, req.userId))) {
      return reply.code(429).send({ error: "操作过于频繁，请稍后再试" });
    }

    // 先确认 Agent 在，再去读文件：不存在的话没必要把几 MB 的 body 收完。
    // 顺带取回旧的 key，等新图落好之后拿它删旧文件。
    const existing = await agentAvatarUrlOf(prisma, req.userId, req.params.id);
    if (!existing) return reply.code(404).send({ error: "智能体不存在" });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "缺少文件" });
    const raw = await data.toBuffer();

    let webp: Buffer;
    try {
      webp = await normalizeAvatarImage(raw);
    } catch (err) {
      // 只有「这张图不合格」才是 400。其他异常（sharp 没装好之类）原样抛出去变成 500 ——
      // 把基础设施故障说成用户的图有问题，只会让人对着一台坏机器反复换图。
      if (err instanceof AvatarImageError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    // key 带时间戳：同一个 Agent 反复换头像会得到不同的 key，CDN 和浏览器缓存自然就失效了。
    // 带 userId 是为了让越权访问在存储层也说不通（即使 bucket 策略配错，路径也对不上）。
    const key = `agent-avatars/${req.userId}/${req.params.id}/${Date.now()}.webp`;
    await storage().put(key, webp, AVATAR_MIME);
    await setAgentAvatarUrl(prisma, req.userId, req.params.id, key);

    // 先写库再删旧图。反过来的话，写库失败会让库里指向一个已经删掉的文件 —— 头像直接变成坏链。
    if (existing.avatarUrl && existing.avatarUrl !== key) {
      void storage()
        .remove(existing.avatarUrl)
        .catch((err) => req.log.warn({ err }, "delete old avatar failed"));
    }

    return { success: true, data: { avatarUrl: avatarPublicUrl(key) } };
  });
}
