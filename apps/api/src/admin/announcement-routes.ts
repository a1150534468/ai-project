import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  active: z.boolean().default(true),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(5000).optional(),
  active: z.boolean().optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

export async function announcementRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  // 公开：当前生效（active 且在 start/end 窗口内）
  app.get("/api/announcements", async () => {
    const now = new Date();
    const rows = await prisma.announcement.findMany({
      where: {
        active: true,
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, body: true, createdAt: true },
    });
    return { success: true, data: rows };
  });

  // admin: 创建公告
  app.post(
    "/api/admin/announcements",
    { preHandler: requireAdmin("ANNOUNCEMENT_MANAGE") },
    async (req, reply) => {
      const p = createSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });
      const a = await prisma.announcement.create({
        data: {
          title: p.data.title,
          body: p.data.body,
          active: p.data.active,
          startAt: p.data.startAt ? new Date(p.data.startAt) : null,
          endAt: p.data.endAt ? new Date(p.data.endAt) : null,
        },
      });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "ANNOUNCEMENT_CREATE", a.id);
      return { success: true, data: a };
    },
  );

  // admin: 更新公告
  app.patch(
    "/api/admin/announcements/:id",
    { preHandler: requireAdmin("ANNOUNCEMENT_MANAGE") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const patch = updateSchema.safeParse(req.body);
      if (!patch.success) return reply.code(400).send({ error: "参数不合法" });

      const data: Record<string, unknown> = {};
      if (patch.data.title !== undefined) data.title = patch.data.title;
      if (patch.data.body !== undefined) data.body = patch.data.body;
      if (patch.data.active !== undefined) data.active = patch.data.active;
      if (patch.data.startAt !== undefined) data.startAt = new Date(patch.data.startAt);
      if (patch.data.endAt !== undefined) data.endAt = new Date(patch.data.endAt);

      const a = await prisma.announcement.update({ where: { id }, data });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "ANNOUNCEMENT_UPDATE", id);
      return { success: true, data: a };
    },
  );

  // admin: 删除公告
  app.delete(
    "/api/admin/announcements/:id",
    { preHandler: requireAdmin("ANNOUNCEMENT_MANAGE") },
    async (req) => {
      const { id } = req.params as { id: string };
      await prisma.announcement.delete({ where: { id } });
      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "ANNOUNCEMENT_DELETE", id);
      return { success: true };
    },
  );
}
