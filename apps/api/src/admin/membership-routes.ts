import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient } from "@ai-assistant/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const upsertSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1).max(128),
  priceFen: z.number().int().positive(),
  durationDays: z.number().int().positive(),
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  grantPoints: z.number().int().nonnegative(),
  enabled: z.boolean(),
});

const deleteSchema = z.object({
  id: z.number().int().positive(),
});

export async function adminMembershipRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/membership-cards",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (_req, reply) => {
      try {
        const rows = await billing.listMembershipCards();
        return { success: true, data: rows.data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.post(
    "/api/admin/membership-cards",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (req, reply) => {
      const p = upsertSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      try {
        await billing.upsertMembershipCard(p.data);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }

      const me = (req as unknown as { admin: { id: string } }).admin;
      const action = p.data.id ? "MEMBERSHIP_CARD_UPSERT" : "MEMBERSHIP_CARD_UPSERT";
      await writeAudit(prisma, me.id, action, p.data.name, p.data);
      return { success: true };
    },
  );

  app.post(
    "/api/admin/membership-cards/delete",
    { preHandler: requireAdmin("MEMBERSHIP_MANAGE") },
    async (req, reply) => {
      const p = deleteSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      try {
        await billing.deleteMembershipCard(p.data.id);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MEMBERSHIP_CARD_DELETE", String(p.data.id), { id: p.data.id });
      return { success: true };
    },
  );
}
