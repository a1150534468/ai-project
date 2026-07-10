import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const genSchema = z.object({
  grantType: z.enum(["BALANCE", "MEMBERSHIP", "FEATURE", "PACKAGE"]),
  grantPayload: z.string().min(2), // JSON 文本
  points: z.number().int().nonnegative().optional(),
  count: z.number().int().min(1).max(1000),
  expiresAt: z.number().int().positive().optional(), // unix 秒
});
const disableSchema = z.object({ code: z.string().min(4).max(64) });

// 校验 grantPayload 形状是否符合 grantType 要求
function validateGrantPayload(grantType: string, payloadStr: string): { ok: boolean; error?: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return { ok: false, error: "grantPayload 不是合法 JSON" };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: `grantPayload 必须是对象，实际: ${typeof payload}` };
  }

  const obj = payload as Record<string, unknown>;

  switch (grantType) {
    case "BALANCE": {
      const points = obj.points;
      if (points === undefined) {
        return { ok: false, error: "BALANCE grantPayload 缺少 points 字段" };
      }
      if (typeof points !== "number" || !Number.isInteger(points) || points <= 0) {
        return { ok: false, error: "BALANCE 的 points 须为正整数" };
      }
      return { ok: true };
    }
    case "MEMBERSHIP": {
      const tier = obj.tier;
      const days = obj.days;
      if (typeof tier !== "string" || tier === "") {
        return { ok: false, error: "MEMBERSHIP grantPayload 缺少非空 tier 字符串" };
      }
      if (typeof days !== "number" || !Number.isInteger(days) || days <= 0) {
        return { ok: false, error: "MEMBERSHIP 的 days 须为正整数" };
      }
      return { ok: true };
    }
    case "FEATURE":
    case "PACKAGE":
      // 暂不校验具体形状，生成支持，兑换时返回不支持
      return { ok: true };
    default:
      return { ok: false, error: `未知 grantType: ${grantType}` };
  }
}

export async function adminCodeRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  app.post(
    "/api/admin/codes",
    { preHandler: requireAdmin("REDEMPTION_MANAGE") },
    async (req, reply) => {
      const p = genSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      // grantPayload 必须是合法 JSON 且形状符合 grantType
      const vr = validateGrantPayload(p.data.grantType, p.data.grantPayload);
      if (!vr.ok) return reply.code(400).send({ error: vr.error });

      let r: { codes: string[] };
      try {
        r = await billing.generateCodes(p.data);
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "CODE_GENERATE", undefined, {
        grantType: p.data.grantType,
        count: p.data.count,
        codeCount: r.codes.length,
      });
      return { success: true, data: r };
    },
  );

  app.get(
    "/api/admin/codes",
    { preHandler: requireAdmin("REDEMPTION_MANAGE") },
    async (req, reply) => {
      const q = req.query as { status?: string; grantType?: string; batchId?: string; limit?: string };
      try {
        const r = await billing.listCodes({
          status: q.status,
          grantType: q.grantType,
          batchId: q.batchId,
          limit: q.limit ? Number(q.limit) : undefined,
        });
        return { success: true, data: r.data };
      } catch {
        return reply.code(502).send({ error: "计费服务不可用" });
      }
    },
  );

  app.post(
    "/api/admin/codes/disable",
    { preHandler: requireAdmin("REDEMPTION_MANAGE") },
    async (req, reply) => {
      const p = disableSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      try {
        await billing.disableCode(p.data.code);
      } catch {
        return reply.code(400).send({ error: "兑换码无法停用" });
      }
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "CODE_DISABLE", p.data.code);
      return { success: true };
    },
  );
}
