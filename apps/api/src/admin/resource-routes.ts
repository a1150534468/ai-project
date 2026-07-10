import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const upsertSchema = z.object({
  resourceKey: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(128).default(""),
  pricingType: z.enum(["PER_CALL", "PER_UNIT", "VIDEO_IO"]),
  rate: z.number().nonnegative(),
  outputRate: z.number().nonnegative().default(0), // 仅 VIDEO_IO：输出视频每秒单价
  perUnits: z.number().int().positive().default(1),
  enabled: z.boolean(),
});

const ratioSchema = z.object({ ratio: z.number().int().positive() });
const rechargePackageSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  amountFen: z.number().int().positive(),
  points: z.number().int().positive(),
  enabled: z.boolean(),
  sortOrder: z.number().int().nonnegative().default(0),
});
const rechargePackagesSchema = z.object({
  packages: z.array(rechargePackageSchema).max(10),
}).superRefine((val, ctx) => {
  const seen = new Set<string>();
  val.packages.forEach((pkg, idx) => {
    if (seen.has(pkg.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "套餐 ID 不能重复",
        path: ["packages", idx, "id"],
      });
    }
    seen.add(pkg.id);
  });
});

export async function resourceRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/resource-prices",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (_req, reply) => {
      try {
        return { success: true, data: (await billing.listResourcePrices()).data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.post(
    "/api/admin/resource-prices",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (req, reply) => {
      const p = upsertSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.upsertResourcePrice(p.data);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "RESOURCE_PRICE_UPSERT", p.data.resourceKey, p.data);
      return { success: true };
    },
  );

  app.post(
    "/api/admin/resource-prices/delete",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (req, reply) => {
      const key = (req.body as { resourceKey?: string }).resourceKey?.trim();
      if (!key) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.deleteResourcePrice(key);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "RESOURCE_PRICE_DELETE", key);
      return { success: true };
    },
  );

  app.get(
    "/api/admin/config/recharge-ratio",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (_req, reply) => {
      try {
        return { success: true, ratio: (await billing.getRechargeRatio()).ratio };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.put(
    "/api/admin/config/recharge-ratio",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (req, reply) => {
      const p = ratioSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.setRechargeRatio(p.data.ratio);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "RECHARGE_RATIO_SET", undefined, { ratio: p.data.ratio });
      return { success: true };
    },
  );

  app.get(
    "/api/admin/config/recharge-packages",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (_req, reply) => {
      try {
        return { success: true, data: (await billing.adminListRechargePackages()).data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.put(
    "/api/admin/config/recharge-packages",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (req, reply) => {
      const p = rechargePackagesSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.setRechargePackages(p.data.packages);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "RECHARGE_PACKAGES_SET", undefined, { count: p.data.packages.length });
      return { success: true };
    },
  );
}
