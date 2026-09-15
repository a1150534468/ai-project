import { getPrisma, getRedis } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { buildIndexDeps } from "./kb/deps.js";
import { startKbReaper } from "./kb/reaper.js";
import { makeS3 } from "./storage/s3.js";
import { startArticleWorkflowReaper } from "./workflow/article/index.js";

export async function startBackgroundServices(app: FastifyInstance): Promise<void> {
  const articleTimer = startArticleWorkflowReaper({ prisma: getPrisma(), redis: getRedis() });
  let stopKnowledgeReaper: (() => void) | undefined;
  app.addHook("onClose", async () => {
    clearInterval(articleTimer);
    stopKnowledgeReaper?.();
  });

  if (process.env.NODE_ENV !== "test") {
    try {
      const reaper = startKbReaper(await buildIndexDeps(makeS3()));
      stopKnowledgeReaper = reaper.stop;
    } catch (error) {
      app.log.warn({ err: error }, "知识库存储/嵌入未配置，跳过 KB 索引 reaper（聊天等功能不受影响）");
    }
  }
}
