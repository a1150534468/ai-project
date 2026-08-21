import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import {
  validateUploadedBgmFile,
  validateVoiceCloneSampleFile,
} from "./audio-service.js";
import { createProjectAudioAsset } from "./local-business-promo-audio-helpers.js";
import {
  authUserId,
  findOwnedProject,
  safeErrorMessage,
  serializeAudioAsset,
  serializeProjectAudioState,
} from "./local-business-promo-route-helpers.js";
import {
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
} from "./local-business-promo-route-types.js";

export function registerLocalBusinessPromoAudioUploadRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/voice-sample", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择音色样本文件" });
    const buffer = Buffer.from(await file.toBuffer());
    try {
      const validated = await validateVoiceCloneSampleFile({
        filename: file.filename,
        mime: file.mimetype,
        buffer,
      });
      const asset = await createProjectAudioAsset({
        prisma: ctx.prisma,
        userId,
        projectId: project.id,
        kind: "voice-sample",
        source: "upload",
        filename: file.filename,
        mime: validated.mime,
        buffer,
        metadata: {
          filename: file.filename,
          uploadedAt: new Date().toISOString(),
        },
      });
      const nextProject = await ctx.prisma.localBusinessPromoProject.update({
        where: { id: project.id },
        data: { voiceCloneSampleAssetId: asset.id },
      });
      return {
        success: true,
        data: {
          asset: serializeAudioAsset(asset),
          audio: await serializeProjectAudioState(ctx.prisma, userId, nextProject),
        },
      };
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
  });

  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/bgm-upload", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择 BGM 文件" });
    const buffer = Buffer.from(await file.toBuffer());
    try {
      const validated = await validateUploadedBgmFile({
        filename: file.filename,
        mime: file.mimetype,
        buffer,
      });
      const asset = await createProjectAudioAsset({
        prisma: ctx.prisma,
        userId,
        projectId: project.id,
        kind: "bgm",
        source: "upload",
        filename: file.filename,
        mime: validated.mime,
        buffer,
        metadata: {
          filename: file.filename,
          uploadedAt: new Date().toISOString(),
        },
      });
      const nextProject = await ctx.prisma.localBusinessPromoProject.update({
        where: { id: project.id },
        data: { activeBgmAssetId: asset.id },
      });
      return {
        success: true,
        data: {
          asset: serializeAudioAsset(asset),
          audio: await serializeProjectAudioState(ctx.prisma, userId, nextProject),
        },
      };
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
  });
}
