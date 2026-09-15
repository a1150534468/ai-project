import { getPrisma } from "@ai-assistant/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasPermission, type Permission } from "./permissions.js";
import { getAdminById } from "./service.js";
import { verifyAdminToken } from "./token.js";

export interface LoadedAdmin {
  readonly id: string;
  readonly role: string;
  readonly permissions: string[];
  readonly disabled: boolean;
}

type AdminAuthResult =
  | { readonly ok: true; readonly admin: LoadedAdmin }
  | { readonly ok: false; readonly code: 401 | 403 };

export async function checkAdminAuth(
  adminId: string | null,
  loadAdmin: (id: string) => Promise<LoadedAdmin | null>,
  permission: Permission,
): Promise<AdminAuthResult> {
  if (!adminId) return { ok: false, code: 401 };
  const admin = await loadAdmin(adminId);
  if (!admin || admin.disabled) return { ok: false, code: 401 };
  if (!hasPermission(admin, permission)) return { ok: false, code: 403 };
  return { ok: true, admin };
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export function requireAdmin(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.ADMIN_SESSION_SECRET;
    if (!secret || secret.length < 32) {
      return reply.code(500).send({ error: "ADMIN_SESSION_SECRET 未配置" });
    }

    const token = bearerToken(request);
    const result = await checkAdminAuth(
      token ? verifyAdminToken(token, secret) : null,
      (id) => getAdminById(getPrisma(), id),
      permission,
    );
    if (!result.ok) {
      const error = result.code === 403 ? `需要 ${permission} 权限` : "管理员未登录或无效";
      return reply.code(result.code).send({ error });
    }
    (request as FastifyRequest & { admin: LoadedAdmin }).admin = result.admin;
  };
}
