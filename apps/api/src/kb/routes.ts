import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import {
  createKb,
  listKbsForUser,
  renameKb,
  deleteKb,
  assertKbOwner,
  assertKbReadable,
} from "./service.js";
import { buildIndexDeps } from "./deps.js";
import { indexOnce } from "./indexer.js";
import { storeAndCreateDocument, IngestError } from "./ingest.js";
import { makeS3, deleteObject } from "../storage/s3.js";

const createKbSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
});

const renameKbSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
});

export async function kbRoutes(app: FastifyInstance) {
  // 本文件 8 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = getPrisma();
  let s3: ReturnType<typeof makeS3> | null = null;
  const getS3 = () => {
    if (!s3) {
      s3 = makeS3();
    }
    return s3;
  };

  // GET /api/kb
  app.get("/api/kb", async (req, reply) => {
    const userId = req.userId;
    const kbs = await listKbsForUser(prisma, userId);
    return reply.send(kbs);
  });

  // POST /api/kb
  app.post("/api/kb", async (req, reply) => {
    const userId = req.userId;
    const parsed = createKbSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }

    const kb = await createKb(prisma, {
      userId,
      name: parsed.data.name,
      description: parsed.data.description,
    });
    return reply.send(kb);
  });

  // PATCH /api/kb/:id
  app.patch("/api/kb/:id", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };
    const parsed = renameKbSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "参数不合法" });
    }

    try {
      const kb = await renameKb(prisma, id, userId, parsed.data);
      return reply.send(kb);
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });

  // DELETE /api/kb/:id
  app.delete("/api/kb/:id", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };

    try {
      await deleteKb(prisma, getS3(), id, userId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /api/kb/:id/documents
  app.get("/api/kb/:id/documents", async (req, reply) => {
    const userId = req.userId;
    const { id } = req.params as { id: string };

    try {
      const kb = await assertKbReadable(prisma, id, userId);
      if (kb.ownerType === "OFFICIAL") {
        return reply.code(403).send({ error: "官方知识库不开放文档明细" });
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
          sourceType: true,
          sourceUri: true,
          mime: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      return reply.send(docs);
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /api/kb/:id/documents/:docId
  app.get("/api/kb/:id/documents/:docId", async (req, reply) => {
    const userId = req.userId;
    const { id, docId } = req.params as { id: string; docId: string };

    try {
      const kb = await assertKbReadable(prisma, id, userId);
      if (kb.ownerType === "OFFICIAL") {
        return reply.code(403).send({ error: "官方知识库不开放文档明细" });
      }
      const doc = await prisma.document.findUnique({ where: { id: docId } });
      if (!doc || doc.kbId !== id) {
        return reply.code(404).send({ error: "文档不存在" });
      }
      return reply.send(doc);
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });

  // DELETE /api/kb/:id/documents/:docId
  app.delete("/api/kb/:id/documents/:docId", async (req, reply) => {
    const userId = req.userId;
    const { id, docId } = req.params as { id: string; docId: string };

    try {
      await assertKbOwner(prisma, id, userId);
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
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /api/kb/:id/documents
  app.post("/api/kb/:id/documents", async (req, reply) => {
    const userId = req.userId;
    const { id: kbId } = req.params as { id: string };

    try {
      await assertKbOwner(prisma, kbId, userId);
    } catch (err) {
      if (err instanceof Error && err.name === "ForbiddenError") {
        return reply.code(403).send({ error: err.message });
      }
      throw err;
    }

    try {
      const result = await storeAndCreateDocument(
        prisma,
        getS3(),
        kbId,
        userId,
        {
          isMultipart: () => req.isMultipart(),
          file: () => req.file(),
          body: (req.body as Record<string, unknown>) || {},
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

      return reply.code(200).send({ id: result.docId, status: "pending" });
    } catch (err) {
      if (err instanceof IngestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      app.log.error(err);
      throw err;
    }
  });

}
