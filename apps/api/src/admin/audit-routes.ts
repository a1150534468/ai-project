import type { FastifyInstance } from "fastify";
import { getPrisma } from "@yc/db";
import { requireAdmin } from "./guard.js";

export async function adminAuditRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get(
    "/api/admin/audit",
    { preHandler: requireAdmin("ADMIN_MANAGE") },
    async (req) => {
      const q = req.query as { adminId?: string; action?: string; limit?: string };
      const where: { adminId?: string; action?: string } = {};
      if (q.adminId) where.adminId = q.adminId;
      if (q.action) where.action = q.action;
      const take = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const data = await prisma.adminAudit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
      });
      return { success: true, data };
    },
  );
}
