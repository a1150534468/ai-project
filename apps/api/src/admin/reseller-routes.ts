import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient, type UserAggRow } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { createReseller, listResellers, updateChannel, getVisibilityConfig, setVisibilityConfig } from "../reseller/service.js";
import { computeChannelSummary } from "../reseller/stats.js";

const createSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
  code: z.string().regex(/^[A-Z]{2}$/),
  commissionRate: z.number().min(0).max(1),
});
const patchSchema = z.object({
  commissionRate: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
});
const visSchema = z.object({
  showRecharge: z.boolean().optional(),
  showConsumption: z.boolean().optional(),
  showMembership: z.boolean().optional(),
  showLastActive: z.boolean().optional(),
});

export async function adminResellerRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get("/api/admin/resellers", { preHandler: requireAdmin("RESELLER_MANAGE") }, async () => {
    return { success: true, data: await listResellers(prisma) };
  });

  app.post("/api/admin/resellers", { preHandler: requireAdmin("RESELLER_MANAGE") }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    if (await prisma.channel.findUnique({ where: { code: p.data.code } })) {
      return reply.code(409).send({ error: "渠道码已被占用" });
    }
    if (await prisma.admin.findUnique({ where: { username: p.data.username } })) {
      return reply.code(409).send({ error: "用户名已占用" });
    }
    const r = await createReseller(prisma, p.data);
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "RESELLER_CREATE", r.channel.id, { code: p.data.code, rate: p.data.commissionRate });
    return { success: true, data: r };
  });

  app.patch("/api/admin/resellers/:channelId", { preHandler: requireAdmin("RESELLER_MANAGE") }, async (req, reply) => {
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    const { channelId } = req.params as { channelId: string };
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.code(404).send({ error: "渠道不存在" });
    const updated = await updateChannel(prisma, channelId, p.data);
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "RESELLER_UPDATE", channelId, p.data);
    return { success: true, data: updated };
  });

  app.get("/api/admin/resellers/:channelId/summary", { preHandler: requireAdmin("RESELLER_MANAGE") }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.code(404).send({ error: "渠道不存在" });
    const users = await prisma.user.findMany({ where: { channelId }, select: { id: true } });
    const ids = users.map((u) => u.id);
    let agg: Record<string, UserAggRow> = {};
    try {
      agg = (await billing.summaryByUsers(ids)).data;
    } catch {
      return reply.code(502).send({ error: "计费数据暂不可用" });
    }
    return { success: true, data: computeChannelSummary(ids, agg, channel.commissionRate) };
  });

  app.get("/api/admin/reseller-visibility", { preHandler: requireAdmin("RESELLER_MANAGE") }, async () => {
    return { success: true, data: await getVisibilityConfig(prisma) };
  });

  app.put("/api/admin/reseller-visibility", { preHandler: requireAdmin("RESELLER_MANAGE") }, async (req, reply) => {
    const p = visSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    const updated = await setVisibilityConfig(prisma, p.data);
    const me = (req as unknown as { admin: { id: string } }).admin;
    await writeAudit(prisma, me.id, "RESELLER_VISIBILITY_UPDATE", "singleton", p.data);
    return { success: true, data: updated };
  });
}
