import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { BillingHttpError, createBillingClient } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const upsertSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(64),
  sortOrder: z.number().int(),
  thresholdRmbFen: z.number().int().nonnegative(),
  discountBps: z.number().int().min(1).max(10000),
  enabled: z.boolean(),
  upgradeEnabled: z.boolean(),
});

const deleteSchema = z.object({
  id: z.number().int().positive(),
});

export async function adminVipRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/vip-levels",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (_req, reply) => {
      try {
        const rows = await billing.adminListVipLevels();
        return { success: true, data: rows.data };
      } catch (err) {
        return sendVipBillingError(reply, err);
      }
    },
  );

  app.post(
    "/api/admin/vip-levels",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (req, reply) => {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数不合法" });
      }
      try {
        const result = await billing.adminUpsertVipLevel(parsed.data);
        const me = (req as unknown as { admin: { id: string } }).admin;
        await writeAudit(prisma, me.id, "VIP_LEVEL_UPSERT", parsed.data.name, parsed.data);
        return { success: true, data: result.data };
      } catch (err) {
        return sendVipBillingError(reply, err);
      }
    },
  );

  app.post(
    "/api/admin/vip-levels/delete",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (req, reply) => {
      const parsed = deleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数不合法" });
      }
      try {
        await billing.adminDeleteVipLevel(parsed.data.id);
        const me = (req as unknown as { admin: { id: string } }).admin;
        await writeAudit(prisma, me.id, "VIP_LEVEL_DELETE", String(parsed.data.id), parsed.data);
        return { success: true };
      } catch (err) {
        return sendVipBillingError(reply, err);
      }
    },
  );
}

function sendVipBillingError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, err: unknown) {
  const status = billingErrorStatus(err);
  if (status !== null) {
    if (status === 400) return reply.code(400).send({ error: "参数不合法" });
    if (status === 404) return reply.code(404).send({ error: "VIP 等级不存在" });
    if (status === 409) return reply.code(409).send({ error: "VIP 等级删除失败" });
  }
  return reply.code(502).send({ error: "计费服务不可用" });
}

function billingErrorStatus(err: unknown) {
  if (err instanceof BillingHttpError) {
    return err.status;
  }
  if (err && typeof err === "object" && (err as { name?: unknown }).name === "BillingHttpError") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  if (err instanceof Error) {
    const match = err.message.match(/\s(400|404|409)$/);
    if (match) return Number(match[1]);
  }
  return null;
}
