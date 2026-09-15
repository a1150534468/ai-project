import { getPrisma } from "@ai-assistant/db";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import { requireAdmin } from "./guard.js";
import { requestAdminId } from "./request-admin.js";

const announcementFields = {
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5_000),
  active: z.boolean(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
};
const createAnnouncementSchema = z.object({
  ...announcementFields,
  active: announcementFields.active.default(true),
  startAt: announcementFields.startAt.optional(),
  endAt: announcementFields.endAt.optional(),
});
const patchAnnouncementSchema = z.object(announcementFields).partial();

function datePatch(input: { startAt?: string; endAt?: string }) {
  return {
    ...(input.startAt !== undefined ? { startAt: new Date(input.startAt) } : {}),
    ...(input.endAt !== undefined ? { endAt: new Date(input.endAt) } : {}),
  };
}

export interface AnnouncementRoutesOptions {
  readonly prisma?: PrismaClient;
}

export async function announcementRoutes(
  app: FastifyInstance,
  options: AnnouncementRoutesOptions = {},
): Promise<void> {
  const prisma = options.prisma ?? getPrisma();
  const authorize = { preHandler: requireAdmin("ANNOUNCEMENT_MANAGE") };

  app.get("/api/announcements", async () => {
    const now = new Date();
    const data = await prisma.announcement.findMany({
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
    return { success: true, data };
  });

  app.post("/api/admin/announcements", authorize, async (request, reply) => {
    const parsed = createAnnouncementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { startAt, endAt, ...fields } = parsed.data;
    const announcement = await prisma.$transaction(async (tx) => {
      const created = await tx.announcement.create({
        data: {
          ...fields,
          startAt: startAt ? new Date(startAt) : null,
          endAt: endAt ? new Date(endAt) : null,
        },
      });
      await writeAudit(tx, requestAdminId(request), "ANNOUNCEMENT_CREATE", created.id);
      return created;
    });
    return { success: true, data: announcement };
  });

  app.patch("/api/admin/announcements/:id", authorize, async (request, reply) => {
    const parsed = patchAnnouncementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const { id } = request.params as { id: string };
    const { startAt, endAt, ...fields } = parsed.data;
    const announcement = await prisma.$transaction(async (tx) => {
      const result = await tx.announcement.updateMany({
        where: { id },
        data: { ...fields, ...datePatch({ startAt, endAt }) },
      });
      if (result.count !== 1) return null;
      await writeAudit(tx, requestAdminId(request), "ANNOUNCEMENT_UPDATE", id);
      return tx.announcement.findUnique({ where: { id } });
    });
    if (!announcement) return reply.code(404).send({ error: "公告不存在" });
    return { success: true, data: announcement };
  });

  app.delete("/api/admin/announcements/:id", authorize, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.announcement.deleteMany({ where: { id } });
      if (result.count !== 1) return false;
      await writeAudit(tx, requestAdminId(request), "ANNOUNCEMENT_DELETE", id);
      return true;
    });
    if (!deleted) return reply.code(404).send({ error: "公告不存在" });
    return { success: true };
  });
}
