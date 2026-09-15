import type { FastifyInstance } from "fastify";
import { buildIndexDeps } from "../kb/deps.js";
import { IngestError, storeAndCreateDocument } from "../kb/ingest.js";
import { indexOnce } from "../kb/indexer.js";
import { deleteObject } from "../storage/s3.js";
import { writeAudit } from "./audit.js";
import { requireAdmin } from "./guard.js";
import type { AdminKnowledgeRouteContext } from "./knowledge-route-context.js";
import { officialKnowledgeBaseExists } from "./knowledge-route-context.js";
import { requestAdminId } from "./request-admin.js";

const DOCUMENT_LIST_SELECT = {
  id: true,
  name: true,
  status: true,
  sizeBytes: true,
  chunkCount: true,
  error: true,
  createdAt: true,
} as const;

export function registerAdminKnowledgeDocumentRoutes(
  app: FastifyInstance,
  context: AdminKnowledgeRouteContext,
): void {
  const { prisma } = context;
  const authorize = { preHandler: requireAdmin("KNOWLEDGE_MANAGE") };

  app.get("/api/admin/kb/:id/documents", authorize, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await officialKnowledgeBaseExists(prisma, id))) {
      return reply.code(404).send({ error: "库不存在或非官方库" });
    }
    const documents = await prisma.document.findMany({
      where: { kbId: id },
      select: DOCUMENT_LIST_SELECT,
      orderBy: { createdAt: "desc" },
    });
    return { success: true, data: documents };
  });

  app.post("/api/admin/kb/:id/documents", authorize, async (req, reply) => {
    const { id: kbId } = req.params as { id: string };
    if (!(await officialKnowledgeBaseExists(prisma, kbId))) {
      return reply.code(404).send({ error: "库不存在或非官方库" });
    }

    try {
      const result = await storeAndCreateDocument(prisma, context.getS3(), kbId, null, {
        isMultipart: () => req.isMultipart(),
        file: () => req.file(),
        body: (req.body as Record<string, unknown>) || {},
      });
      void buildIndexDeps(context.getS3())
        .then((deps) => indexOnce(deps, result.docId))
        .catch(() => undefined);
      await writeAudit(prisma, requestAdminId(req), "KB_DOC_CREATE", kbId, {
        docId: result.docId,
        name: result.doc.name,
      });
      return { success: true, data: { id: result.docId, status: "pending" } };
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error(error);
      throw error;
    }
  });

  app.delete("/api/admin/kb/:id/documents/:docId", authorize, async (req, reply) => {
    const { id: kbId, docId } = req.params as { id: string; docId: string };
    const removed = await prisma.$transaction(async (tx) => {
      const where = {
        id: docId,
        kbId,
        kb: { is: { ownerType: "OFFICIAL" } },
      };
      const document = await tx.document.findFirst({
        where,
        select: { name: true, sourceType: true, sourceUri: true },
      });
      if (!document) return null;
      const deleted = await tx.document.deleteMany({ where });
      return deleted.count === 1 ? document : null;
    });
    if (!removed) return reply.code(404).send({ error: "文档不存在" });

    if (removed.sourceUri && (removed.sourceType === "FILE" || removed.sourceType === "TEXT")) {
      await deleteObject(context.getS3(), removed.sourceUri).catch(() => undefined);
    }
    await writeAudit(prisma, requestAdminId(req), "KB_DOC_DELETE", kbId, {
      docId,
      name: removed.name,
    });
    return reply.code(204).send();
  });
}
