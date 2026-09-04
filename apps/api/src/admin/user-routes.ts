import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { buildAdminUserDetail } from "./user-detail.js";
import { generateUniqueUid } from "../auth/uid.js";

const createUserSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
});

export async function adminUserRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  app.get(
    "/api/admin/users",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const query = req.query as { q?: string; page?: string; pageSize?: string };
      const q = query.q?.trim();
      // page 需夹上界：超大数字串会让 skip 溢出 Prisma 的 Int64 直接 500
      const rawPage = Number.parseInt(query.page ?? "", 10);
      const page = Number.isNaN(rawPage) ? 1 : Math.min(1_000_000, Math.max(1, rawPage));
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? "", 10) || 20));
      const where = q
        ? {
            OR: [
              { uid: { contains: q, mode: "insensitive" as const } },
              { username: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {};
      const [total, data] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          // id 兜底排序：批量导入的用户 createdAt 相同，无 tiebreaker 会跨页重复/丢失
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            uid: true,
            username: true,
            bannedAt: true,
            createdAt: true,
          },
        }),
      ]);
      return {
        success: true,
        data,
        total,
        page,
        pageSize,
      };
    },
  );

  app.post(
    "/api/admin/users",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req, reply) => {
      const p = createUserSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      if (await prisma.user.findUnique({ where: { username: p.data.username } })) {
        return reply.code(409).send({ error: "用户名已被占用" });
      }
      const uid = await generateUniqueUid(
        async (u) => Boolean(await prisma.user.findUnique({ where: { uid: u } })),
      );
      const passwordHash = await argon2.hash(p.data.password);
      const user = await prisma.user.create({
        data: {
          uid,
          username: p.data.username,
          passwordHash,
        },
        select: {
          id: true,
          uid: true,
          username: true,
          createdAt: true,
        },
      });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_CREATE", user.id, { uid: user.uid });
      return { success: true, data: user };
    },
  );

  app.post(
    "/api/admin/users/:id/ban",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.user.update({ where: { id }, data: { bannedAt: new Date() } });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_BAN", id);
      return { success: true };
    },
  );

  app.post(
    "/api/admin/users/:id/unban",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.user.update({ where: { id }, data: { bannedAt: null } });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_UNBAN", id);
      return { success: true };
    },
  );

  app.get(
    "/api/admin/users/:id/detail",
    { preHandler: requireAdmin("USER_DETAIL_VIEW") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, uid: true, username: true, bannedAt: true, createdAt: true },
      });
      if (!user) return reply.code(404).send({ error: "用户不存在" });

      return {
        success: true,
        data: await buildAdminUserDetail(prisma, user),
      };
    },
  );
}
