import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBillingClient } from "@yc/billing";

const topupSchema = z.object({
  amountFen: z.number().int().positive().optional(),
  packageId: z.string().min(1).max(64).optional(),
  method: z.enum(["alipay", "wxpay"]),
  accountType: z.enum(["points", "video"]).optional(),
}).superRefine((val, ctx) => {
  const accountType = val.accountType ?? "points";
  if (accountType === "video" && val.packageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "视频点只支持自定义充值" });
  }
  if (!val.amountFen && !val.packageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amountFen 或 packageId 必填" });
  }
  if (val.amountFen && val.packageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amountFen 与 packageId 只能传一个" });
  }
});

const redeemSchema = z.object({
  code: z.string().min(4).max(64),
});

const tradeNoParamsSchema = z.object({
  tradeNo: z.string().min(1).max(80),
});

export async function billingRoutes(app: FastifyInstance) {
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.post("/api/billing/topup", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    const p = topupSchema.safeParse(req.body);
    if (!p.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }
    return billing.createTopup({ userId, ...p.data });
  });

  app.get("/api/billing/recharge-packages", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      return await billing.listRechargePackages();
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/billing/recharge-ratio", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      return await billing.getRechargeRatio();
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/billing/usage", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).default(20) }).safeParse(req.query);
    if (!q.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }
    try {
      return await billing.listUsage(userId, q.data.limit);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/billing/topup/:tradeNo", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    const p = tradeNoParamsSchema.safeParse(req.params);
    if (!p.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }
    try {
      return await billing.getTopupOrder(userId, p.data.tradeNo);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/vip/me", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      return await billing.getVipSummary(userId);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.get("/api/model-marketplace", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      return await billing.listModelMarketplace(userId);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });

  app.post("/api/billing/redeem", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    const p = redeemSchema.safeParse(req.body);
    if (!p.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }
    return billing.redeem({ code: p.data.code, userId });
  });

  app.get("/api/billing/balance", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    return billing.getBalance(userId);
  });

  app.get("/api/billing/points-detail", async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      return await billing.pointsDetail(userId);
    } catch {
      return reply.code(502).send({ error: "计费服务不可用" });
    }
  });
}
