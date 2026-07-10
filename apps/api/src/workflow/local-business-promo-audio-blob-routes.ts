import type { FastifyInstance } from "fastify";
import { getObject, loadS3Config, makeS3 } from "../storage/s3.js";
import {
  audioBlobMimeFromQuery,
  findOwnedProject,
  hasValidProjectAudioBlobAccess,
  isAllowedProjectAudioKey,
  isAllowedProjectVideoKey,
  videoBlobMimeFromQuery,
} from "./local-business-promo-route-helpers.js";
import {
  projectAudioBlobQuerySchema,
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
} from "./local-business-promo-route-types.js";

async function loadProjectForBlobAccess(args: {
  readonly ctx: LocalBusinessPromoRouteContext;
  readonly requestUserId: string | null;
  readonly projectId: string;
}) {
  const ownedProject = args.requestUserId
    ? await findOwnedProject(args.ctx.prisma, args.requestUserId, args.projectId)
    : null;
  const project = ownedProject
    ?? await args.ctx.prisma.localBusinessPromoProject.findFirst({ where: { id: args.projectId } });
  return {
    ownedProject,
    project,
  };
}

export function registerLocalBusinessPromoAudioBlobRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.get("/api/workflow/local-business-promos/projects/:projectId/audio/blob", async (req, reply) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const query = projectAudioBlobQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "参数不合法" });
    const requestUserId = (req as { userId?: string }).userId?.trim() || null;
    const signedMime = query.data.mime?.trim() || "";
    const { ownedProject, project } = await loadProjectForBlobAccess({
      ctx,
      requestUserId,
      projectId: params.data.projectId,
    });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const isOwner = Boolean(ownedProject);
    const hasSignedAccess = query.data.exp !== undefined
      && query.data.sig !== undefined
      && hasValidProjectAudioBlobAccess({
        projectId: project.id,
        objectKey: query.data.key,
        mime: signedMime,
        exp: query.data.exp,
        sig: query.data.sig,
      });
    if (!isOwner && !hasSignedAccess) {
      return reply.code(401).send({ error: "未登录" });
    }
    if (!isAllowedProjectAudioKey(project.userId, project.id, query.data.key)) {
      return reply.code(404).send({ error: "音频文件不存在" });
    }
    try {
      const buffer = await getObject(makeS3(loadS3Config()), query.data.key);
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(audioBlobMimeFromQuery(query.data.key, query.data.mime))
        .send(buffer);
    } catch {
      return reply.code(502).send({ error: "音频文件下载失败" });
    }
  });

  app.get("/api/workflow/local-business-promos/projects/:projectId/video/blob", async (req, reply) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const query = projectAudioBlobQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "参数不合法" });
    const requestUserId = (req as { userId?: string }).userId?.trim() || null;
    const signedMime = query.data.mime?.trim() || "";
    const { ownedProject, project } = await loadProjectForBlobAccess({
      ctx,
      requestUserId,
      projectId: params.data.projectId,
    });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const isOwner = Boolean(ownedProject);
    const hasSignedAccess = query.data.exp !== undefined
      && query.data.sig !== undefined
      && hasValidProjectAudioBlobAccess({
        projectId: project.id,
        objectKey: query.data.key,
        mime: signedMime,
        exp: query.data.exp,
        sig: query.data.sig,
      });
    if (!isOwner && !hasSignedAccess) {
      return reply.code(401).send({ error: "未登录" });
    }
    if (!isAllowedProjectVideoKey(project.userId, project.id, query.data.key)) {
      return reply.code(404).send({ error: "视频文件不存在" });
    }
    try {
      const buffer = await getObject(makeS3(loadS3Config()), query.data.key);
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(videoBlobMimeFromQuery(query.data.key, query.data.mime))
        .send(buffer);
    } catch {
      return reply.code(502).send({ error: "视频文件下载失败" });
    }
  });
}
