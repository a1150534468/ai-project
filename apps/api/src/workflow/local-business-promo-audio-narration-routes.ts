import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  storeWorkflowAudio,
  synthesizeMimoSpeech,
} from "./audio-service.js";
import {
  buildNarrationAudioMetadata,
  createProjectAudioAsset,
  createTransientAudioAsset,
  ensureNarrationText,
  findOrCreatePresetNarrationPreviewAsset,
  resolveNarrationGenerationInput,
} from "./local-business-promo-audio-helpers.js";
import {
  authUserId,
  findOwnedProject,
  projectAudioBlobUrl,
  safeErrorMessage,
  serializeAudioAsset,
  serializeAudioTask,
  serializeProjectAudioState,
} from "./local-business-promo-route-helpers.js";
import {
  LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT,
  projectParamsSchema,
  type LocalBusinessPromoRouteContext,
} from "./local-business-promo-route-types.js";

export function registerLocalBusinessPromoNarrationRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/narration/preview", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    let input: Awaited<ReturnType<typeof resolveNarrationGenerationInput>>;
    try {
      input = await resolveNarrationGenerationInput({
        prisma: ctx.prisma,
        userId,
        project,
        fetchFn: ctx.fetchFn,
        text: LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT,
      });
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
    try {
      if (input.voiceMode === "preset") {
        const asset = await findOrCreatePresetNarrationPreviewAsset({
          prisma: ctx.prisma,
          userId,
          fetchFn: ctx.fetchFn,
          narrationVoice: input.narrationVoice ?? "vv-female-natural",
        });
        return {
          success: true,
          data: {
            asset: serializeAudioAsset(asset, project.id),
          },
        };
      }

      const audio = await synthesizeMimoSpeech({
        fetchFn: ctx.fetchFn,
        model: input.model,
        text: input.text,
        presetVoiceId: input.presetVoiceId,
        voiceDesignPrompt: input.voiceDesignPrompt,
        voiceStylePrompt: input.voiceStylePrompt,
        voiceSampleDataUrl: input.voiceSampleDataUrl,
      });
      const stored = await storeWorkflowAudio({
        userId,
        filename: `narration-preview-${input.voiceMode}.wav`,
        mime: audio.mime,
        buffer: audio.buffer,
        folder: `workflow/audio/${userId}/${project.id}/preview`,
      });
      return {
        success: true,
        data: {
          asset: createTransientAudioAsset({
            kind: "narration",
            source: "mimo-tts",
            provider: "mimo",
            providerModel: input.model,
            requestId: `preview:${randomUUID()}`,
            originalUrl: stored.url,
            playbackUrl: stored.objectKey ? projectAudioBlobUrl(project.id, stored.objectKey, stored.mime) : stored.url,
            objectKey: stored.objectKey,
            mime: stored.mime,
            format: stored.format,
            durationSec: stored.durationSec,
            textContent: input.text,
            metadata: { preview: true, ...buildNarrationAudioMetadata(input) },
          }),
        },
      };
    } catch (error) {
      app.log.warn({ err: error, projectId: project.id }, "local business promo narration preview failed");
      return reply.code(502).send({ error: safeErrorMessage(error) || "口播试听失败" });
    }
  });

  app.post("/api/workflow/local-business-promos/projects/:projectId/audio/narration/generate", async (req, reply) => {
    const userId = authUserId(req as { userId?: string }, reply);
    if (!userId) return;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await findOwnedProject(ctx.prisma, userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    let input: Awaited<ReturnType<typeof resolveNarrationGenerationInput>>;
    try {
      input = await resolveNarrationGenerationInput({
        prisma: ctx.prisma,
        userId,
        project,
        fetchFn: ctx.fetchFn,
        text: ensureNarrationText(project),
      });
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
    const requestId = `local-business-promo-audio:${project.id}:narration:${randomUUID()}`;
    const task = await ctx.prisma.audioGenerationTask.create({
      data: {
        userId,
        projectId: project.id,
        requestId,
        kind: "narration",
        provider: "mimo",
        providerModel: input.model,
        status: "running",
        inputPayload: {
          text: input.text,
          ...buildNarrationAudioMetadata(input),
        },
      },
    });
    try {
      const audio = await synthesizeMimoSpeech({
        fetchFn: ctx.fetchFn,
        model: input.model,
        text: input.text,
        presetVoiceId: input.presetVoiceId,
        voiceDesignPrompt: input.voiceDesignPrompt,
        voiceStylePrompt: input.voiceStylePrompt,
        voiceSampleDataUrl: input.voiceSampleDataUrl,
      });
      const asset = await createProjectAudioAsset({
        prisma: ctx.prisma,
        userId,
        projectId: project.id,
        kind: "narration",
        source: "mimo-tts",
        provider: "mimo",
        providerModel: input.model,
        requestId,
        filename: `${project.id}-${requestId}.wav`,
        mime: audio.mime,
        buffer: audio.buffer,
        textContent: input.text,
        metadata: buildNarrationAudioMetadata(input),
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
        data: { activeNarrationAssetId: asset.id },
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
      app.log.warn({ err: error, projectId: project.id, requestId }, "local business promo narration generation failed");
      return reply.code(502).send({ error: message || "口播生成失败" });
    }
  });
}
