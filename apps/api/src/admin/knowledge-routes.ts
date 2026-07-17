import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient } from "@ai-assistant/billing";
import { requireAdmin } from "./guard.js";
import { writeAudit } from "./audit.js";
import { createKb, deleteKb } from "../kb/service.js";
import { storeAndCreateDocument, IngestError } from "../kb/ingest.js";
import { makeS3, deleteObject, deletePrefix } from "../storage/s3.js";
import { buildIndexDeps } from "../kb/deps.js";
import { indexOnce } from "../kb/indexer.js";

const kbCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
});

const kbUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
});

const userQuotaGrantSchema = z.object({
  bytes: z.number().int().positive(), // 仅允许正数（扩容）
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().max(500).optional(),
});

export async function adminKnowledgeRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  let s3: ReturnType<typeof makeS3> | null = null;
  const getS3 = () => {
    if (!s3) {
      s3 = makeS3();
    }
    return s3;
  };

  const billing = createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });

  // =====================
  // 官方知识库 CRUD
  // =====================

  // GET /api/admin/kb - 列所有官方库
  app.get(
    "/api/admin/kb",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (_req, _reply) => {
      const kbs = await prisma.knowledgeBase.findMany({
        where: { ownerType: "OFFICIAL" },
        orderBy: { createdAt: "desc" },
      });
      return { success: true, data: kbs };
    },
  );

  // POST /api/admin/kb - 建官方库
  app.post(
    "/api/admin/kb",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const p = kbCreateSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      const kb = await createKb(prisma, {
        userId: null,
        name: p.data.name,
        description: p.data.description,
        ownerType: "OFFICIAL",
      });

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "KB_CREATE", kb.id, { name: kb.name, ownerType: "OFFICIAL" });

      return { success: true, data: kb };
    },
  );

  // PATCH /api/admin/kb/:id - 改官方库信息
  app.patch(
    "/api/admin/kb/:id",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = kbUpdateSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      // 校验库存在且为 OFFICIAL
      const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
      if (!kb || kb.ownerType !== "OFFICIAL") {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }

      const updateData: { name?: string; description?: string } = {};
      if (p.data.name !== undefined) updateData.name = p.data.name;
      if (p.data.description !== undefined) updateData.description = p.data.description;

      const updated = await prisma.knowledgeBase.update({
        where: { id },
        data: updateData,
      });

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "KB_UPDATE", id, updateData);

      return { success: true, data: updated };
    },
  );

  // DELETE /api/admin/kb/:id - 删官方库（级联删文档+chunk，删S3）
  app.delete(
    "/api/admin/kb/:id",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      // 校验库存在且为 OFFICIAL
      const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
      if (!kb || kb.ownerType !== "OFFICIAL") {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }

      try {
        await deleteKb(prisma, getS3(), id, null as any); // 该函数会检查所有权，但 OFFICIAL 库 userId=null，跳过此检查
      } catch (err) {
        if (err instanceof Error && err.name === "ForbiddenError") {
          return reply.code(404).send({ error: "库不存在" });
        }
        throw err;
      }

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "KB_DELETE", id, { ownerType: "OFFICIAL" });

      return reply.code(204).send();
    },
  );

  // GET /api/admin/kb/:id/documents - 列官方库的文档
  app.get(
    "/api/admin/kb/:id/documents",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      // 校验库存在且为 OFFICIAL
      const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
      if (!kb || kb.ownerType !== "OFFICIAL") {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }

      const docs = await prisma.document.findMany({
        where: { kbId: id },
        select: {
          id: true,
          name: true,
          status: true,
          sizeBytes: true,
          chunkCount: true,
          error: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return { success: true, data: docs };
    },
  );

  // POST /api/admin/kb/:id/documents - 加文档到官方库（跳计费）
  app.post(
    "/api/admin/kb/:id/documents",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const { id: kbId } = req.params as { id: string };

      // 校验库存在且为 OFFICIAL
      const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      if (!kb || kb.ownerType !== "OFFICIAL") {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }

      try {
        const result = await storeAndCreateDocument(
          prisma,
          getS3(),
          kbId,
          null, // 官方库无 userId
          {
            isMultipart: () => req.isMultipart(),
            file: () => req.file(),
            body: (req.body as Record<string, unknown>) || {},
          },
          {
            skipQuotaCheck: true, // 官方库跳计费
            billing: null,
            quotaBilling: undefined,
          }
        );

        // 触发索引（best-effort）
        void (async () => {
          try {
            const deps = await buildIndexDeps(getS3());
            await indexOnce(deps, result.docId);
          } catch {
            // 索引失败交 reaper 重试
          }
        })();

        const me = (req as unknown as { admin: { id: string } }).admin;
        await writeAudit(prisma, me.id, "KB_DOC_CREATE", kbId, { docId: result.docId, name: result.doc.name });

        return { success: true, data: { id: result.docId, status: "pending" } };
      } catch (err) {
        if (err instanceof IngestError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        app.log.error(err);
        throw err;
      }
    },
  );

  // DELETE /api/admin/kb/:id/documents/:docId - 删文档
  app.delete(
    "/api/admin/kb/:id/documents/:docId",
    { preHandler: requireAdmin("KNOWLEDGE_MANAGE") },
    async (req, reply) => {
      const { id, docId } = req.params as { id: string; docId: string };

      // 校验库存在且为 OFFICIAL
      const kb = await prisma.knowledgeBase.findUnique({ where: { id } });
      if (!kb || kb.ownerType !== "OFFICIAL") {
        return reply.code(404).send({ error: "库不存在或非官方库" });
      }

      const doc = await prisma.document.findUnique({ where: { id: docId } });
      if (!doc || doc.kbId !== id) {
        return reply.code(404).send({ error: "文档不存在" });
      }

      // 删 Chunk → Document → S3 对象
      await prisma.chunk.deleteMany({ where: { documentId: docId } });
      if (doc.sourceUri && (doc.sourceType === "FILE" || doc.sourceType === "TEXT")) {
        try {
          await deleteObject(getS3(), doc.sourceUri);
        } catch {
          // S3 删除失败继续
        }
      }
      await prisma.document.delete({ where: { id: docId } });

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "KB_DOC_DELETE", id, { docId, name: doc.name });

      return reply.code(204).send();
    },
  );

  // =====================
  // 用户调配额（USER_MANAGE）
  // =====================

  // POST /api/admin/users/:id/kb-quota - 给用户配额
  app.post(
    "/api/admin/users/:id/kb-quota",
    { preHandler: requireAdmin("USER_MANAGE") },
    async (req, reply) => {
      const { id: userId } = req.params as { id: string };
      const p = userQuotaGrantSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: "参数不合法" });

      // 校验 bytes > 0
      if (p.data.bytes <= 0) {
        return reply.code(400).send({ error: "配额必须大于 0" });
      }

      // 校验用户存在
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply.code(404).send({ error: "用户不存在" });
      }

      const grant = await prisma.kbQuotaGrant.create({
        data: {
          userId,
          bytes: p.data.bytes,
          source: "ADMIN",
          expiresAt: p.data.expiresAt ? new Date(p.data.expiresAt) : null,
          note: p.data.note,
        },
      });

      const me = (req as unknown as { admin: { id: string } }).admin;
      await writeAudit(prisma, me.id, "USER_KB_QUOTA_GRANT", userId, {
        bytes: grant.bytes,
        expiresAt: grant.expiresAt,
      });

      return { success: true, data: grant };
    },
  );
}
