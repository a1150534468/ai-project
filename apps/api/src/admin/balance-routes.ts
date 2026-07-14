import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const adjustSchema = z.object({
  delta: z.number().int().refine((v) => v !== 0, "delta 不能为 0"),
  reason: z.string().min(1).max(256),
  accountType: z.enum(["points", "video"]).default("points"),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export async function adminBalanceRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.post(
    "/api/admin/users/:id/balance",
    { preHandler: requireAdmin("BALANCE_ADJUST") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = adjustSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      // 目标用户必须存在
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!target) return reply.code(404).send({ error: "用户不存在" });

      const me = (req as unknown as { admin: { id: string } }).admin;
      const operationId = `adj:${p.data.idempotencyKey ?? randomUUID()}`;

      let result: { before: number; after: number };
      try {
        result = await billing.adjustBalance({
          operationId,
          userId: id,
          delta: p.data.delta,
          reason: p.data.reason,
          adminId: me.id,
          accountType: p.data.accountType,
        });
      } catch (e) {
        if (e instanceof InsufficientBalanceError) {
          return reply.code(400).send({ error: "余额不足，无法扣减" });
        }
        // billing 不可用：失败即拒、不假成功（CLAUDE.md 红线）
        return reply.code(502).send({ error: "计费服务不可用，调整未执行" });
      }

      await writeAudit(prisma, me.id, "BALANCE_ADJUST", id, {
        delta: p.data.delta,
        reason: p.data.reason,
        accountType: p.data.accountType,
        before: result.before,
        after: result.after,
        operationId,
      });
      return { success: true, data: result };
    },
  );
}
