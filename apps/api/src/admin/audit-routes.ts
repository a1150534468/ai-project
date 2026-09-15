import { getPrisma } from "@ai-assistant/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./guard.js";

interface AuditQuery {
  readonly adminId?: string;
  readonly action?: string;
  readonly limit?: string;
}

export interface AdminAuditRoutesOptions {
  readonly prisma?: PrismaClient;
}

function auditFilter(query: AuditQuery): Prisma.AdminAuditWhereInput {
  return {
    ...(query.adminId ? { adminId: query.adminId } : {}),
    ...(query.action ? { action: query.action } : {}),
  };
}

export async function adminAuditRoutes(
  app: FastifyInstance,
  options: AdminAuditRoutesOptions = {},
): Promise<void> {
  const prisma = options.prisma ?? getPrisma();
  app.get(
    "/api/admin/audit",
    { preHandler: requireAdmin("ADMIN_MANAGE") },
    async (request) => {
      const query = request.query as AuditQuery;
      const take = Math.min(200, Math.max(1, Number(query.limit) || 100));
      const data = await prisma.adminAudit.findMany({
        where: auditFilter(query),
        orderBy: { createdAt: "desc" },
        take,
      });
      return { success: true, data };
    },
  );
}
