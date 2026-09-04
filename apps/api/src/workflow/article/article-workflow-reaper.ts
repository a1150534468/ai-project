import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { articleProjectStaleMs } from "./article-workflow-shared.js";

export const ARTICLE_REAPER_LOCK_KEY = "ai-assistant:article-workflow:reaper:lock";
const ARTICLE_REAPER_INTERVAL_MS = 60_000;

/**
 * 收割进程崩溃/重启后卡在 generating|revising 的图文项目：
 * updatedAt 是天然心跳（runner 每步都写进度，@updatedAt 自动刷新），超期即认定无人继续。
 * 按原状态条件抢占置 failed——避免与正在收尾的 runner 双写。
 */
export async function reapStaleArticleWorkflowProjects(args: {
  readonly prisma: PrismaClient;
  readonly staleMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}): Promise<number> {
  const threshold = new Date((args.now?.() ?? Date.now()) - (args.staleMs ?? articleProjectStaleMs(args.env)));
  const stuck = await args.prisma.articleWorkflowProject.findMany({
    where: { status: { in: ["generating", "revising"] }, updatedAt: { lt: threshold } },
    select: { id: true, status: true },
  });

  let reaped = 0;
  for (const row of stuck) {
    const claimed = await args.prisma.articleWorkflowProject.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: "failed",
        progressStage: "failed",
        progressPercent: 100,
        progressMessage: "生成超时中断",
        error: "服务重启或任务超时，已自动终止，可重新发起生成",
      },
    }).catch(() => ({ count: 0 }));
    if (claimed.count !== 1) continue;
    reaped += 1;
  }
  return reaped;
}

export function startArticleWorkflowReaper(args: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly env?: NodeJS.ProcessEnv;
}): NodeJS.Timeout {
  const tick = async () => {
    const got = await args.redis.set(ARTICLE_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
    if (got !== "OK") return;
    try {
      await reapStaleArticleWorkflowProjects(args);
    } catch {
      // 留给下一轮重试
    }
  };
  const timer = setInterval(() => void tick(), ARTICLE_REAPER_INTERVAL_MS);
  timer.unref();
  return timer;
}
