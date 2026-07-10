import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const tokenPricingSchema = {
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional(),
  cacheInputPricePerMillion: z.number().nonnegative().optional(),
  cacheOutputPricePerMillion: z.number().nonnegative().optional(),
};

const rmbPricingSchema = {
  inputPriceRmbPerMillion: z.number().nonnegative().optional(),
  outputPriceRmbPerMillion: z.number().nonnegative().optional(),
  cacheInputPriceRmbPerMillion: z.number().nonnegative().optional(),
  cacheOutputPriceRmbPerMillion: z.number().nonnegative().optional(),
};

const upsertSchema = z.object({
  model: z.string().min(1).max(128),
  displayName: z.string().max(128).default(""),
  ...tokenPricingSchema,
  ...rmbPricingSchema,
  enabled: z.boolean(),
  description: z.string().max(2000).optional(),
  tags: z.string().max(1000).optional(),
  contextLength: z.number().int().nonnegative().optional(),
  useCases: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
  showInMarketplace: z.boolean().optional(),
}).superRefine(requireCompletePricing);

const pricingSchema = z.object({
  model: z.string().min(1).max(128),
  ...tokenPricingSchema,
  ...rmbPricingSchema,
}).superRefine(requireCompletePricing);

const displaySchema = z.object({
  model: z.string().min(1).max(128),
  displayName: z.string().max(128),
  enabled: z.boolean(),
  description: z.string().max(2000).optional(),
  tags: z.string().max(1000).optional(),
  contextLength: z.number().int().nonnegative().optional(),
  useCases: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
  showInMarketplace: z.boolean().optional(),
});
const identitySchema = z.object({
  model: z.string().min(1).max(128),
  newModel: z.string().min(1).max(128),
  displayName: z.string().max(128),
  enabled: z.boolean(),
});
const deleteSchema = z.object({
  model: z.string().min(1).max(128),
});

function requireCompletePricing(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  const tokenKeys = ["inputPricePerMillion", "outputPricePerMillion", "cacheInputPricePerMillion", "cacheOutputPricePerMillion"];
  const rmbKeys = ["inputPriceRmbPerMillion", "outputPriceRmbPerMillion", "cacheInputPriceRmbPerMillion", "cacheOutputPriceRmbPerMillion"];
  const hasAllToken = tokenKeys.every((key) => value[key] !== undefined);
  const hasAllRmb = rmbKeys.every((key) => value[key] !== undefined);
  if (!hasAllToken && !hasAllRmb) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "需完整提供人民币价格或旧算力点价格",
    });
  }
}

// 公开 /api/models 短缓存（避免每请求打 billing）
const MODELS_CACHE_TTL_MS = 30_000;
let modelsCache: { at: number; data: { model: string; displayName: string }[] } | null = null;

export async function adminModelRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get(
    "/api/admin/models",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (_req, reply) => {
      try {
        const r = await billing.listModels();
        return { success: true, data: r.data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.post(
    "/api/admin/models",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (req, reply) => {
      const p = upsertSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.upsertModel(toUpsertPayload(p.data));
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      modelsCache = null;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MODEL_UPSERT", p.data.model, p.data);
      return { success: true };
    },
  );

  app.patch(
    "/api/admin/models/pricing",
    { preHandler: requireAdmin("PRICING_MANAGE") },
    async (req, reply) => {
      const p = pricingSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.updateModelPricing(toPricingPayload(p.data));
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      modelsCache = null;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MODEL_PRICING", p.data.model, p.data);
      return { success: true };
    },
  );

  app.patch(
    "/api/admin/models/display",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (req, reply) => {
      const p = displaySchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.updateModelDisplay({
          model: p.data.model,
          displayName: p.data.displayName,
          enabled: p.data.enabled,
          ...marketplacePayload(p.data),
        });
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      modelsCache = null;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MODEL_DISPLAY", p.data.model, p.data);
      return { success: true };
    },
  );

  app.patch(
    "/api/admin/models/identity",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (req, reply) => {
      const p = identitySchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.updateModelIdentity(p.data);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      modelsCache = null;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MODEL_IDENTITY", p.data.model, p.data);
      return { success: true };
    },
  );

  app.post(
    "/api/admin/models/delete",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (req, reply) => {
      const p = deleteSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.deleteModel(p.data.model);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      modelsCache = null;
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "MODEL_DELETE", p.data.model, p.data);
      return { success: true };
    },
  );

  app.get(
    "/api/admin/models/stats",
    { preHandler: requireAdmin("MODEL_MANAGE") },
    async (req, reply) => {
      const modelName = String((req.query as { model?: string }).model ?? "");
      if (!modelName.trim()) return reply.code(400).send({ error: "参数不合法" });
      try {
        const r = await billing.getModelStats(modelName);
        return { success: true, data: r.data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  // 公开：启用模型列表（短缓存；billing 故障时返回缓存或空，不抛错阻塞前端）
  app.get("/api/models", async () => {
    const now = Date.now();
    if (modelsCache && now - modelsCache.at < MODELS_CACHE_TTL_MS) {
      return { data: modelsCache.data };
    }
    try {
      const r = await billing.listEnabledModels();
      modelsCache = { at: now, data: r.data };
      return { data: r.data };
    } catch {
      return { data: modelsCache?.data ?? [] };
    }
  });
}

type ParsedUpsert = z.infer<typeof upsertSchema>;
type ParsedPricing = z.infer<typeof pricingSchema>;

function toUpsertPayload(value: ParsedUpsert) {
  return {
    model: value.model,
    displayName: value.displayName,
    enabled: value.enabled,
    ...pricingPayload(value),
    ...marketplacePayload(value),
  };
}

function toPricingPayload(value: ParsedPricing) {
  return {
    model: value.model,
    ...pricingPayload(value),
  };
}

function pricingPayload(value: ParsedPricing) {
  if (
    value.inputPriceRmbPerMillion !== undefined &&
    value.outputPriceRmbPerMillion !== undefined &&
    value.cacheInputPriceRmbPerMillion !== undefined &&
    value.cacheOutputPriceRmbPerMillion !== undefined
  ) {
    return {
      inputPriceRmbPerMillion: value.inputPriceRmbPerMillion,
      outputPriceRmbPerMillion: value.outputPriceRmbPerMillion,
      cacheInputPriceRmbPerMillion: value.cacheInputPriceRmbPerMillion,
      cacheOutputPriceRmbPerMillion: value.cacheOutputPriceRmbPerMillion,
    };
  }
  return {
    inputPricePerMillion: value.inputPricePerMillion ?? 0,
    outputPricePerMillion: value.outputPricePerMillion ?? 0,
    cacheInputPricePerMillion: value.cacheInputPricePerMillion ?? 0,
    cacheOutputPricePerMillion: value.cacheOutputPricePerMillion ?? 0,
  };
}

function marketplacePayload(value: {
  description?: string;
  tags?: string;
  contextLength?: number;
  useCases?: string;
  sortOrder?: number;
  showInMarketplace?: boolean;
}) {
  return {
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.tags !== undefined ? { tags: value.tags } : {}),
    ...(value.contextLength !== undefined ? { contextLength: value.contextLength } : {}),
    ...(value.useCases !== undefined ? { useCases: value.useCases } : {}),
    ...(value.sortOrder !== undefined ? { sortOrder: value.sortOrder } : {}),
    ...(value.showInMarketplace !== undefined ? { showInMarketplace: value.showInMarketplace } : {}),
  };
}
