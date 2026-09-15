import { getPrisma } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import { requireAdmin } from "./guard.js";
import { GRANTABLE_PERMISSIONS } from "./permissions.js";
import { requestAdminId } from "./request-admin.js";
import { createAdmin, listAdmins, updateAdmin, verifyLogin } from "./service.js";
import { signAdminToken } from "./token.js";

const grantablePermission = z.enum(GRANTABLE_PERMISSIONS);
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const createAdminSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
  permissions: z.array(grantablePermission).default([]),
});
const patchAdminSchema = z.object({
  permissions: z.array(grantablePermission).optional(),
  disabled: z.boolean().optional(),
});

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export interface AdminRoutesOptions {
  readonly prisma?: PrismaClient;
}

export async function adminRoutes(app: FastifyInstance, options: AdminRoutesOptions = {}): Promise<void> {
  const prisma = options.prisma ?? getPrisma();
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("ADMIN_SESSION_SECRET 必须 ≥32 字节");
  const canManageAdmins = { preHandler: requireAdmin("ADMIN_MANAGE") };

  app.post("/api/admin/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const admin = await verifyLogin(prisma, parsed.data.username, parsed.data.password);
    if (!admin) return reply.code(401).send({ error: "账号或密码错误，或已被禁用" });
    return {
      token: signAdminToken(admin.id, secret),
      adminId: admin.id,
      role: admin.role,
      permissions: admin.permissions,
    };
  });

  app.post("/api/admin/admins", canManageAdmins, async (request, reply) => {
    const parsed = createAdminSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    if (await prisma.admin.findUnique({ where: { username: parsed.data.username }, select: { id: true } })) {
      return reply.code(409).send({ error: "管理员用户名已占用" });
    }
    const createdBy = requestAdminId(request);
    try {
      const created = await createAdmin(prisma, { ...parsed.data, role: "admin", createdBy });
      await writeAudit(prisma, createdBy, "ADMIN_CREATE", created.id, {
        permissions: parsed.data.permissions,
      });
      return { success: true, data: created };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: "管理员用户名已占用" });
      }
      throw error;
    }
  });

  app.get("/api/admin/admins", canManageAdmins, async () => ({
    success: true,
    data: await listAdmins(prisma),
  }));

  app.patch("/api/admin/admins/:id", canManageAdmins, async (request, reply) => {
    const parsed = patchAdminSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { id } = request.params as { id: string };
    const adminId = requestAdminId(request);
    const updated = await updateAdmin(prisma, id, parsed.data);
    await writeAudit(prisma, adminId, "ADMIN_UPDATE", id, parsed.data);
    return { success: true, data: updated };
  });
}
