import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { InsufficientBalanceError } from "@yc/billing";
import { authUserId } from "./ecom-route-helpers.js";
import { extractFanoutBrief } from "./fanout-extract-service.js";
import { generateFanout } from "./fanout-generate-service.js";
import { isFanoutDimensionId, FANOUT_MIN_COUNT, FANOUT_MAX_COUNT } from "./fanout-dimensions.js";
import type { FanoutBrief, FanoutGenerateInput, FanoutGenerateResult } from "./fanout-types.js";

const extractSchema = z.object({ raw: z.string().trim().min(1).max(8000) });

const briefSchema = z.object({
  product: z.string().trim().min(1).max(500),
  audience: z.string().trim().max(200).default(""),
  sellingPoints: z.array(z.string().trim().max(300)).max(30).default([]),
  style: z.string().trim().max(120).default(""),
  scene: z.string().trim().max(200).default(""),
});

const generateSchema = z.object({
  mode: z.enum(["enum", "matrix", "script"]),
  brief: briefSchema,
  count: z.number().int().min(FANOUT_MIN_COUNT).max(FANOUT_MAX_COUNT),
  dimension: z.string().optional(),
  dedup: z.boolean().optional(),
}).refine((v) => v.mode !== "enum" || (v.dimension != null && isFanoutDimensionId(v.dimension)), {
  message: "enum 模式必须提供合法 dimension",
});

type FanoutDeps = {
  readonly extract?: (i: { userId: string; raw: string }) => Promise<FanoutBrief>;
  readonly generate?: (i: FanoutGenerateInput) => Promise<FanoutGenerateResult>;
};

export async function fanoutRoutes(app: FastifyInstance, deps: FanoutDeps = {}) {
  const extract = deps.extract ?? extractFanoutBrief;
  const generate = deps.generate ?? generateFanout;

  app.post("/api/workflow/fanout/extract", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = extractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const brief = await extract({ userId, raw: parsed.data.raw });
      return { success: true, data: { brief } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      app.log.error(error);
      return reply.code(502).send({ error: "理解失败，请精简原文后重试" });
    }
  });

  app.post("/api/workflow/fanout/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const result = await generate({ ...parsed.data, dimension: parsed.data.dimension as FanoutGenerateInput["dimension"], userId });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      app.log.error(error);
      return reply.code(502).send({ error: "生成失败，请稍后重试" });
    }
  });
}
