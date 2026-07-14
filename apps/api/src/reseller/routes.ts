import type { FastifyInstance } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, type UserAggRow } from "@ai-assistant/billing";
import { requireReseller } from "./guard.js";
import { getVisibilityConfig } from "./service.js";
import { computeChannelSummary, buildUserRows } from "./stats.js";

export async function resellerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get("/api/reseller/summary", { preHandler: requireReseller() }, async (req, reply) => {
    const { channelId } = (req as unknown as { reseller: { channelId: string } }).reseller;
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.code(404).send({ error: "渠道不存在" });
    const users = await prisma.user.findMany({ where: { channelId }, select: { id: true } });
    const ids = users.map((u) => u.id);
    let agg: Record<string, UserAggRow> = {};
    try {
      agg = (await billing.summaryByUsers(ids)).data;
    } catch {
      return reply.code(502).send({ error: "数据暂不可用" });
    }
    return { success: true, data: computeChannelSummary(ids, agg, channel.commissionRate) };
  });

  app.get("/api/reseller/users", { preHandler: requireReseller() }, async (req, reply) => {
    const { channelId } = (req as unknown as { reseller: { channelId: string } }).reseller;
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
    const [users, total, vis] = await Promise.all([
      prisma.user.findMany({
        where: { channelId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, uid: true, username: true, createdAt: true },
      }),
      prisma.user.count({ where: { channelId } }),
      getVisibilityConfig(prisma),
    ]);
    const ids = users.map((u) => u.id);
    let agg: Record<string, UserAggRow> = {};
    try {
      agg = (await billing.summaryByUsers(ids)).data;
    } catch {
      return reply.code(502).send({ error: "数据暂不可用" });
    }
    // membership/lastActiveAt MVP 先给 null（可见项开启时列出现但值为 null，真实源后续接）
    const records = users.map((u) => ({ ...u, lastActiveAt: null, membership: null }));
    return { success: true, data: { rows: buildUserRows(records, agg, vis), total, page, pageSize } };
  });
}
