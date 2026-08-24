import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  loadLocalBusinessPromoBgmBinary,
  localBusinessPromoBgmPresetFile,
  storeWorkflowAudio,
  type WorkflowAudioBinary,
} from "./audio-service.js";
import {
  createProjectAudioAsset,
  createTransientAudioAsset,
} from "./local-business-promo-audio-helpers.js";
import { normalizeSettings } from "./local-business-promo-core.js";
import {
  authUserId,
  findOwnedProject,
  projectAudioBlobUrl,
  safeErrorMessage,
  serializeAudioAsset,
  serializeAudioTask,
  serializeProjectAudioState,
} from "./local-business-promo-route-helpers.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
} from "./local-business-promo-route-types.js";

export function registerLocalBusinessPromoBgmRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/bgm/preview", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const settings = normalizeSettings(project.settings);
    if (settings.musicPreset === "no-bgm") {
      return { success: true, data: { asset: null } };
    }
    try {
      const file = localBusinessPromoBgmPresetFile(settings.musicPreset);
      const audio = await loadLocalBusinessPromoBgmBinary(settings.musicPreset);
      if (!file || !audio) {
        return reply.code(404).send({ error: "当前背景音乐预设不存在" });
      }
      const stored = await storeWorkflowAudio({
        userId,
        filename: file.filename,
        mime: audio.mime,
        buffer: audio.buffer,
        folder: `workflow/audio/${userId}/${project.id}/preview`,
      });
      return {
        success: true,
        data: {
          asset: createTransientAudioAsset({
            kind: "bgm",
            source: "local-bgm",
            provider: "local",
            providerModel: "local-business-promo-bgm",
            requestId: `preview:${randomUUID()}`,
            originalUrl: stored.url,
            playbackUrl: stored.objectKey ? projectAudioBlobUrl(project.id, stored.objectKey, stored.mime) : stored.url,
            objectKey: stored.objectKey,
            mime: stored.mime,
            format: stored.format,
            durationSec: stored.durationSec,
            metadata: {
              preview: true,
              musicPreset: settings.musicPreset,
              label: file.label,
            },
          }),
        },
      };
    } catch (error) {
      app.log.warn({ err: error, projectId: project.id }, "local business promo bgm preview failed");
      return reply.code(502).send({ error: errorMessageOrFallback(error, "背景音乐试听失败") });
    }
  });

  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/bgm/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const settings = normalizeSettings(project.settings);
    if (settings.musicPreset === "no-bgm") {
      const nextProject = await ctx.prisma.localBusinessPromoProject.update({
        where: { id: project.id },
        data: { activeBgmAssetId: null },
      });
      return {
        success: true,
        data: {
          asset: null,
          task: null,
          audio: await serializeProjectAudioState(ctx.prisma, userId, nextProject),
        },
      };
    }
    const file = localBusinessPromoBgmPresetFile(settings.musicPreset);
    if (!file) return reply.code(404).send({ error: "当前背景音乐预设不存在" });
    const requestId = `local-business-promo-audio:${project.id}:bgm:${randomUUID()}`;
    const task = await ctx.prisma.audioGenerationTask.create({
      data: {
        userId,
        projectId: project.id,
        requestId,
        kind: "bgm",
        provider: "local",
        providerModel: "local-business-promo-bgm",
        status: "running",
        inputPayload: {
          musicPreset: settings.musicPreset,
          filename: file.filename,
          label: file.label,
        },
      },
    });
    try {
      const audio: WorkflowAudioBinary | null = await loadLocalBusinessPromoBgmBinary(settings.musicPreset);
      if (!audio) throw new Error("当前背景音乐预设不存在");
      const asset = await createProjectAudioAsset({
        prisma: ctx.prisma,
        userId,
        projectId: project.id,
        kind: "bgm",
        source: "local-bgm",
        provider: "local",
        providerModel: "local-business-promo-bgm",
        requestId,
        filename: file.filename,
        mime: audio.mime,
        buffer: audio.buffer,
        metadata: {
          musicPreset: settings.musicPreset,
          label: file.label,
        },
      });
      const completedTask = await ctx.prisma.audioGenerationTask.update({
        where: { id: task.id },
        data: {
          status: "completed",
          error: null,
          assetId: asset.id,
          resultPayload: {
            originalUrl: asset.originalUrl,
            objectKey: asset.objectKey,
            mime: asset.mime,
            format: asset.format,
            durationSec: asset.durationSec,
          },
          completedAt: new Date(),
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
          task: serializeAudioTask(completedTask),
          audio: await serializeProjectAudioState(ctx.prisma, userId, nextProject),
        },
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      await ctx.prisma.audioGenerationTask.update({
        where: { id: task.id },
        data: {
          status: "failed",
          error: message,
          completedAt: new Date(),
        },
      }).catch(() => undefined);
      app.log.warn({ err: error, projectId: project.id, requestId }, "local business promo bgm generation failed");
      return reply.code(502).send({ error: message || "背景音乐生成失败" });
    }
  });
}
