import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createKb, deleteKb, ForbiddenError } from "../kb/service.js";
import { writeAudit } from "./audit.js";
import { requireAdmin } from "./guard.js";
import type { AdminKnowledgeRouteContext } from "./knowledge-route-context.js";
import { requestAdminId } from "./request-admin.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1_000).optional(),
});
const patchSchema = createSchema.partial();

export function registerAdminKnowledgeBaseRoutes(
  app: FastifyInstance,
  context: AdminKnowledgeRouteContext,
): void {
  const { prisma } = context;
  const authorize = { preHandler: requireAdmin("KNOWLEDGE_MANAGE") };

  app.get("/api/admin/kb", authorize, async () => ({
    success: true,
    data: await prisma.knowledgeBase.findMany({
      where: { ownerType: "OFFICIAL" },
      orderBy: { createdAt: "desc" },
    }),
  }));

  app.post("/api/admin/kb", authorize, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const knowledgeBase = await createKb(prisma, {
      ...parsed.data,
      userId: null,
      ownerType: "OFFICIAL",
    });
    await writeAudit(prisma, requestAdminId(req), "KB_CREATE", knowledgeBase.id, {
      name: knowledgeBase.name,
      ownerType: "OFFICIAL",
    });
    return { success: true, data: knowledgeBase };
  });

  app.patch("/api/admin/kb/:id", authorize, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.knowledgeBase.updateMany({
        where: { id, ownerType: "OFFICIAL" },
        data: parsed.data,
      });
      return result.count === 1 ? tx.knowledgeBase.findUnique({ where: { id } }) : null;
    });
    if (!updated) return reply.code(404).send({ error: "库不存在或非官方库" });

    await writeAudit(prisma, requestAdminId(req), "KB_UPDATE", id, parsed.data);
    return { success: true, data: updated };
  });

  app.delete("/api/admin/kb/:id", authorize, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteKb(prisma, context.getS3(), id, null);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }
      throw error;
    }
    await writeAudit(prisma, requestAdminId(req), "KB_DELETE", id, { ownerType: "OFFICIAL" });
    return reply.code(204).send();
  });
}
