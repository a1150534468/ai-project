import type { FastifyReply, FastifyRequest } from "fastify";
import { getPrisma } from "@yc/db";
import { verifyAdminToken } from "../admin/token.js";
import { getAdminById } from "../admin/service.js";

interface LoadedAdmin {
  id: string;
  role: string;
  disabled: boolean;
}

interface LoadedChannel {
  id: string;
  enabled: boolean;
  resellerId: string | null;
}

// 纯核：解析结果 → 判定 + 返回 channelId
export async function checkReseller(
  adminId: string | null,
  loadAdmin: (id: string) => Promise<LoadedAdmin | null>,
  loadChannel: (resellerId: string) => Promise<LoadedChannel | null>,
): Promise<{
  ok: boolean;
  code?: number;
  adminId?: string;
  channelId?: string;
}> {
  if (!adminId) return { ok: false, code: 401 };
  const admin = await loadAdmin(adminId);
  if (!admin || admin.disabled) return { ok: false, code: 401 };
  if (admin.role !== "reseller") return { ok: false, code: 403 };
  const channel = await loadChannel(adminId);
  if (!channel) return { ok: false, code: 403 };
  return { ok: true, adminId, channelId: channel.id };
}

// Fastify preHandler：把 { adminId, channelId } 注入 req.reseller
export function requireReseller() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.ADMIN_SESSION_SECRET;
    if (!secret || secret.length < 32) {
      return reply.code(500).send({ error: "ADMIN_SESSION_SECRET 未配置" });
    }
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const adminId = token ? verifyAdminToken(token, secret) : null;
    const prisma = getPrisma();
    const r = await checkReseller(
      adminId,
      (id) => getAdminById(prisma, id) as Promise<LoadedAdmin | null>,
      (rid) =>
        prisma.channel.findFirst({
          where: { resellerId: rid },
          select: { id: true, enabled: true, resellerId: true },
        }),
    );
    if (!r.ok) {
      const msg = r.code === 403 ? "无代理权限" : "代理未登录或无效";
      return reply.code(r.code!).send({ error: msg });
    }
    (
      req as unknown as {
        reseller: { adminId: string; channelId: string };
      }
    ).reseller = {
      adminId: r.adminId!,
      channelId: r.channelId!,
    };
  };
}
