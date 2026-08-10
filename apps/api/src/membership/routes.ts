import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { z } from "zod";
import { createBillingClient } from "@ai-assistant/billing";

const buySchema = z.object({
  cardId: z.number().int().positive(),
  method: z.enum(["alipay", "wxpay"]).default("alipay"),
});

export async function membershipUserRoutes(app: FastifyInstance) {
  // 本文件 3 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.get("/api/membership/cards", async (req, reply) => {
    const userId = req.userId;
    try {
      return billing.listEnabledCards();
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.post("/api/membership/buy", async (req, reply) => {
    const userId = req.userId;
    const p = buySchema.safeParse(req.body);
    if (!p.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }
    try {
      return billing.buyMembership(userId, p.data.cardId, p.data.method);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/membership/mine", async (req, reply) => {
    const userId = req.userId;
    try {
      return billing.myMemberships(userId);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });
}
