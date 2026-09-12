import type { FastifyInstance } from "fastify";
import { authUserId } from "../_shared/route-auth.js";
import {
  articleWorkflowBatchParamsSchema,
  articleWorkflowImageBlobParamsSchema,
  articleWorkflowImageBlobQuerySchema,
  articleWorkflowProjectParamsSchema,
} from "./article-workflow-schema.js";
import { findOwnedArticleWorkflowProject } from "./article-workflow-store.js";
import {
  articleWorkflowImageBlobSignatureValid,
} from "./article-workflow-image-url.js";
import {
  serializeArticleWorkflowProject,
  serializeArticleWorkflowProjectSummary,
} from "./article-workflow-serializer.js";
import { ARTICLE_HISTORY_LIMIT, type ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";

type ReadRouteContext = {
  readonly prisma: NonNullable<ArticleWorkflowRouteDeps["prisma"]>;
  readonly env: NodeJS.ProcessEnv;
  readonly loadImageBlob: (objectKey: string) => Promise<Buffer>;
};

export function registerArticleWorkflowReadRoutes(app: FastifyInstance, ctx: ReadRouteContext): void {
  const { prisma, env, loadImageBlob } = ctx;

  app.get("/api/workflow/article-workflow/history", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const rows = await prisma.articleWorkflowProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: ARTICLE_HISTORY_LIMIT,
    });
    return { success: true, data: rows.map(serializeArticleWorkflowProjectSummary) };
  });

  app.get("/api/workflow/article-workflow/images/:assetId/blob", async (req, reply) => {
    const params = articleWorkflowImageBlobParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const query = articleWorkflowImageBlobQuerySchema.safeParse(req.query ?? {});
    const signed = query.success && query.data.exp && query.data.sig
      ? articleWorkflowImageBlobSignatureValid({
          assetId: params.data.assetId,
          expiresAtMs: Number(query.data.exp),
          signature: query.data.sig,
          env,
        })
      : false;
    const userId = signed ? undefined : authUserId(req as { userId?: string }, reply) ?? undefined;
    if (!signed && !userId) return;
    const asset = await prisma.imageAsset.findFirst({
      where: userId ? { id: params.data.assetId, userId } : { id: params.data.assetId },
      select: { objectKey: true, mime: true },
    });
    if (!asset?.objectKey) return reply.code(404).send({ error: "配图不存在" });
    try {
      const bytes = await loadImageBlob(asset.objectKey);
      return reply
        .header("Cache-Control", "private, max-age=86400")
        .header("X-Content-Type-Options", "nosniff")
        .type(asset.mime.startsWith("image/") ? asset.mime : "image/png")
        .send(bytes);
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "配图加载失败" });
    }
  });

  app.get("/api/workflow/article-workflow/batch/:batchId", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowBatchParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const rows = await prisma.articleWorkflowProject.findMany({
      where: { userId, batchId: params.data.batchId },
      orderBy: { createdAt: "asc" },
    });
    if (!rows.length) return reply.code(404).send({ error: "批次不存在" });
    return {
      success: true,
      data: { batchId: params.data.batchId, projects: rows.map((row) => serializeArticleWorkflowProject(row, env)) },
    };
  });

  app.get("/api/workflow/article-workflow/:id", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = articleWorkflowProjectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedArticleWorkflowProject(prisma, userId, params.data.id);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return { success: true, data: serializeArticleWorkflowProject(project, env) };
  });
}
