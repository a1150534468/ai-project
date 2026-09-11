import { getPrisma } from "@ai-assistant/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/require-user.js";
import { deleteObject, makeS3 } from "../storage/s3.js";
import { buildIndexDeps } from "./deps.js";
import { IngestError, storeAndCreateDocument } from "./ingest.js";
import { indexOnce } from "./indexer.js";
import {
  assertKbOwner,
  assertKbReadable,
  createKb,
  deleteKb,
  deleteKbDocument,
  listKbsForUser,
  renameKb,
} from "./service.js";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
});
const renameSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
});
const documentSelect = {
  id: true,
  name: true,
  status: true,
  sizeBytes: true,
  chunkCount: true,
  error: true,
  sourceType: true,
  sourceUri: true,
  mime: true,
  createdAt: true,
} as const;

const forbidden = (error: unknown) => error instanceof Error && error.name === "ForbiddenError";
const storedObject = (doc: { sourceType: string; sourceUri: string | null }) =>
  doc.sourceUri && (doc.sourceType === "FILE" || doc.sourceType === "TEXT") ? doc.sourceUri : null;

export async function kbRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  const prisma = getPrisma();
  let s3: ReturnType<typeof makeS3> | null = null;
  const getS3 = () => (s3 ??= makeS3());

  app.get("/api/kb", async (req, reply) => reply.send(await listKbsForUser(prisma, req.userId)));

  app.post("/api/kb", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    return reply.send(await createKb(prisma, { userId: req.userId, ...parsed.data }));
  });

  app.patch("/api/kb/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      return reply.send(await renameKb(prisma, id, req.userId, parsed.data));
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.delete("/api/kb/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteKb(prisma, getS3(), id, req.userId);
      return reply.code(204).send();
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.get("/api/kb/:id/documents", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const kb = await assertKbReadable(prisma, id, req.userId);
      if (kb.ownerType === "OFFICIAL") return reply.code(403).send({ error: "官方知识库不开放文档明细" });
      const docs = await prisma.document.findMany({
        where: { kbId: id },
        select: documentSelect,
        orderBy: { createdAt: "desc" },
      });
      return reply.send(docs);
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.get("/api/kb/:id/documents/:docId", async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    try {
      const kb = await assertKbReadable(prisma, id, req.userId);
      if (kb.ownerType === "OFFICIAL") return reply.code(403).send({ error: "官方知识库不开放文档明细" });
      const doc = await prisma.document.findFirst({ where: { id: docId, kbId: id }, select: documentSelect });
      return doc ? reply.send(doc) : reply.code(404).send({ error: "文档不存在" });
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.delete("/api/kb/:id/documents/:docId", async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    try {
      const doc = await deleteKbDocument(prisma, id, docId, req.userId);
      if (!doc) return reply.code(404).send({ error: "文档不存在" });
      const key = storedObject(doc);
      if (key) await deleteObject(getS3(), key).catch(() => undefined);
      return reply.code(204).send();
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.post("/api/kb/:id/documents", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await assertKbOwner(prisma, id, req.userId);
      const result = await storeAndCreateDocument(prisma, getS3(), id, req.userId, {
        isMultipart: () => req.isMultipart(),
        file: () => req.file(),
        body: (req.body as Record<string, unknown>) || {},
      });
      void (async () => {
        try {
          await indexOnce(await buildIndexDeps(getS3()), result.docId);
        } catch {
          // The reaper retries pending documents.
        }
      })();
      return reply.code(200).send({ id: result.docId, status: "pending" });
    } catch (error) {
      if (forbidden(error)) return reply.code(403).send({ error: (error as Error).message });
      if (error instanceof IngestError) return reply.code(error.statusCode).send({ error: error.message });
      app.log.error(error);
      throw error;
    }
  });
}
