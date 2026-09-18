import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { InsufficientBalanceError } from "../_shared/unmetered-image-usage.js";
import { authUserId } from "../_shared/route-auth.js";
import { helpWriteEcomField, type HelpWriteInput } from "./ecom-helpwrite-service.js";

const helpWriteSchema = z.object({
  field: z.enum(["sellingPoints", "extra"]),
  productName: z.string().trim().min(1).max(200),
  category: z.string().trim().max(200).default(""),
  sellingPoints: z.array(z.string().trim().max(200)).max(12).default([]),
});

type EcomHelpWriteDeps = { readonly helpWrite?: (input: HelpWriteInput) => Promise<string> };

export async function ecomHelpWriteRoutes(app: FastifyInstance, deps: EcomHelpWriteDeps = {}) {
  const helpWrite = deps.helpWrite ?? helpWriteEcomField;
  app.post("/api/workflow/ecom/help-write", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const parsed = helpWriteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const text = await helpWrite({ ...parsed.data, userId });
      return { success: true, data: { text } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      app.log.error(error);
      return reply.code(502).send({ error: "帮我写失败，请稍后重试" });
    }
  });
}
