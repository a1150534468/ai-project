import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@yc/db";
import { verifyLogin, createAdmin, listAdmins, updateAdmin } from "./service.js";
import { signAdminToken } from "./token.js";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { PERMISSIONS } from "./permissions.js";

// ADMIN_MANAGE 仅 super_admin（由 role 隐式拥有），不可作为可授予权限发给普通 admin（防伪超管提权）
const GRANTABLE_PERMISSIONS = PERMISSIONS.filter((p) => p !== "ADMIN_MANAGE");
const permEnum = z.enum([...GRANTABLE_PERMISSIONS] as [string, ...string[]]);
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const createSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
  permissions: z.array(permEnum).default([]),
});
const patchSchema = z.object({
  permissions: z.array(permEnum).optional(),
  disabled: z.boolean().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("ADMIN_SESSION_SECRET 必须 ≥32 字节");

  app.post("/api/admin/login", async (req, reply) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    const admin = await verifyLogin(prisma, p.data.username, p.data.password);
    if (!admin) return reply.code(401).send({ error: "账号或密码错误，或已被禁用" });
    return { token: signAdminToken(admin.id, secret), adminId: admin.id, role: admin.role, permissions: admin.permissions };
  });

  app.post("/api/admin/admins", { preHandler: requireAdmin("ADMIN_MANAGE") }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    if (await prisma.admin.findUnique({ where: { username: p.data.username } })) {
      return reply.code(409).send({ error: "管理员用户名已占用" });
    }
    const me = (req as unknown as { admin: { id: string } }).admin;
    const created = await createAdmin(prisma, { ...p.data, role: "admin", createdBy: me.id });
    await writeAudit(prisma, me.id, "ADMIN_CREATE", created.id, { permissions: p.data.permissions });
    return { success: true, data: created };
  });

  app.get("/api/admin/admins", { preHandler: requireAdmin("ADMIN_MANAGE") }, async () => {
    return { success: true, data: await listAdmins(prisma) };
  });

  app.patch("/api/admin/admins/:id", { preHandler: requireAdmin("ADMIN_MANAGE") }, async (req, reply) => {
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "参数不合法" });
    const { id } = req.params as { id: string };
    const me = (req as unknown as { admin: { id: string } }).admin;
    const updated = await updateAdmin(prisma, id, p.data);
    await writeAudit(prisma, me.id, "ADMIN_UPDATE", id, p.data);
    return { success: true, data: updated };
  });
}
