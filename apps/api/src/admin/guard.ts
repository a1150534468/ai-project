import type { FastifyReply, FastifyRequest } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import type { PrismaClient } from "@ai-assistant/db";
import { verifyAdminToken } from "./token.js";
import { getAdminById } from "./service.js";
import { hasPermission, type Permission } from "./permissions.js";

export interface LoadedAdmin {
  id: string;
  role: string;
  permissions: string[];
  disabled: boolean;
}

// 纯核：adminId 已解析；loadAdmin 取库；返回判定
export async function checkAdminAuth(
  adminId: string | null,
  loadAdmin: (id: string) => Promise<LoadedAdmin | null>,
  permission: Permission,
): Promise<{ ok: boolean; code?: number; admin?: LoadedAdmin }> {
  if (!adminId) return { ok: false, code: 401 };
  const admin = await loadAdmin(adminId);
  if (!admin || admin.disabled) return { ok: false, code: 401 };
  if (!hasPermission(admin, permission)) return { ok: false, code: 403 };
  return { ok: true, admin };
}

// Fastify preHandler 工厂：解析 admin token → checkAdminAuth → 通过则把 admin 挂到 req
export function requireAdmin(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.ADMIN_SESSION_SECRET;
    if (!secret || secret.length < 32) {
      return reply.code(500).send({ error: "ADMIN_SESSION_SECRET 未配置" });
    }
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const adminId = token ? verifyAdminToken(token, secret) : null;
    const prisma = getPrisma();
    const r = await checkAdminAuth(
      adminId,
      (id) => getAdminById(prisma, id) as Promise<LoadedAdmin | null>,
      permission,
    );
    if (!r.ok) {
      const msg = r.code === 403 ? `需要 ${permission} 权限` : "管理员未登录或无效";
      return reply.code(r.code!).send({ error: msg });
    }
    (req as unknown as { admin: LoadedAdmin }).admin = r.admin!;
  };
}
