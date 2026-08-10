import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { requireUser } from "../auth/require-user.js";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { callImageGeneration, loadImageGenerationConfig } from "./image-service.js";
import { findComicVideoModel, listComicVideoModels } from "./comic-video-models.js";
import { loadSeedanceConfig, pollSeedanceVideoTask, submitSeedanceVideoTask } from "./comic-video-service.js";
import { normalizeComicAssetIds } from "./comic-types.js";
import {
  assetParamsSchema,
  createAssetSchema,
  createShotSchema,
  episodeParamsSchema,
  errorMessage,
  generateImageSchema,
  generateShotListSchema,
  generateVideoSchema,
  persistGeneratedImage,
  projectParamsSchema,
  serializeAsset,
  serializeShot,
  shotChunks,
  shotParamsSchema,
  updateAssetSchema,
  updateShotSchema,
  type FetchLike,
} from "./comic-production-helpers.js";

export interface ComicProductionRouteOptions extends FastifyPluginOptions {
  readonly prisma?: PrismaClient;
  readonly fetchFn?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

export async function comicProductionRoutes(app: FastifyInstance, opts: ComicProductionRouteOptions = {}) {
  const prisma = opts.prisma ?? getPrisma();
  const fetchFn = opts.fetchFn ?? fetch;
  const env = opts.env ?? process.env;

  app.get("/api/workflow/comics/projects/:projectId/assets", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await prisma.comicWorkflowProject.findFirst({ where: { id: params.data.projectId, userId } });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const rows = await prisma.comicWorkflowAsset.findMany({ where: { projectId: project.id, userId }, include: { imageAsset: true }, orderBy: { updatedAt: "desc" } });
    return { success: true, data: rows.map(serializeAsset) };
  });

  app.post("/api/workflow/comics/projects/:projectId/assets", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = projectParamsSchema.safeParse(req.params);
    const body = createAssetSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const project = await prisma.comicWorkflowProject.findFirst({ where: { id: params.data.projectId, userId } });
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const row = await prisma.comicWorkflowAsset.create({
      data: { projectId: project.id, userId, ...body.data },
    });
    return reply.code(201).send({ success: true, data: serializeAsset(row) });
  });

  app.patch("/api/workflow/comics/assets/:assetId", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = assetParamsSchema.safeParse(req.params);
    const body = updateAssetSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const asset = await prisma.comicWorkflowAsset.findFirst({ where: { id: params.data.assetId, userId } });
    if (!asset) return reply.code(404).send({ error: "资产不存在" });
    const row = await prisma.comicWorkflowAsset.update({ where: { id: asset.id }, data: body.data });
    return { success: true, data: serializeAsset(row) };
  });

  app.delete("/api/workflow/comics/assets/:assetId", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = assetParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const asset = await prisma.comicWorkflowAsset.findFirst({ where: { id: params.data.assetId, userId } });
    if (!asset) return reply.code(404).send({ error: "资产不存在" });
    await prisma.comicWorkflowAsset.delete({ where: { id: asset.id } });
    return { success: true };
  });

  app.post("/api/workflow/comics/assets/:assetId/generate-image", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = assetParamsSchema.safeParse(req.params);
    const body = generateImageSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const asset = await prisma.comicWorkflowAsset.findFirst({ where: { id: params.data.assetId, userId }, include: { project: true } });
    if (!asset) return reply.code(404).send({ error: "资产不存在" });
    const prompt = body.data.prompt || `${asset.project.style}\n${asset.type}：${asset.name}\n${asset.description}\n${asset.prompt}`.trim();
    try {
      const config = loadImageGenerationConfig(env);
      const image = await callImageGeneration({ config, prompt, size: body.data.size, fetchFn, env });
      const imageAssetId = await persistGeneratedImage({ prisma, fetchFn, env, userId, prompt, size: body.data.size, config, image });
      const row = await prisma.comicWorkflowAsset.update({ where: { id: asset.id }, data: { imageAssetId, prompt }, include: { imageAsset: true } });
      return { success: true, data: serializeAsset(row) };
    } catch (error) {
      return reply.code(502).send({ error: `资产图片生成失败: ${errorMessage(error)}` });
    }
  });

  app.get("/api/workflow/comics/episodes/:episodeId/shots", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = episodeParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const episode = await prisma.comicWorkflowEpisode.findFirst({ where: { id: params.data.episodeId, userId } });
    if (!episode) return reply.code(404).send({ error: "剧集不存在" });
    const rows = await prisma.comicWorkflowShot.findMany({ where: { episodeId: episode.id, userId }, include: { imageAsset: true }, orderBy: { shotNo: "asc" } });
    return { success: true, data: rows.map(serializeShot) };
  });

  app.post("/api/workflow/comics/episodes/:episodeId/shots", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = episodeParamsSchema.safeParse(req.params);
    const body = createShotSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const episode = await prisma.comicWorkflowEpisode.findFirst({ where: { id: params.data.episodeId, userId } });
    if (!episode) return reply.code(404).send({ error: "剧集不存在" });
    const latest = await prisma.comicWorkflowShot.findFirst({ where: { episodeId: episode.id, userId }, orderBy: { shotNo: "desc" } });
    const row = await prisma.comicWorkflowShot.create({
      data: {
        episodeId: episode.id,
        projectId: episode.projectId,
        userId,
        shotNo: latest ? latest.shotNo + 1 : 1,
        ...body.data,
        assetIds: [...normalizeComicAssetIds(body.data.assetIds)],
      },
    });
    return reply.code(201).send({ success: true, data: serializeShot(row) });
  });

  app.post("/api/workflow/comics/episodes/:episodeId/shots/generate", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = episodeParamsSchema.safeParse(req.params);
    const body = generateShotListSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const episode = await prisma.comicWorkflowEpisode.findFirst({ where: { id: params.data.episodeId, userId } });
    if (!episode) return reply.code(404).send({ error: "剧集不存在" });
    const script = episode.scriptVersionId
      ? await prisma.comicWorkflowScriptVersion.findFirst({ where: { id: episode.scriptVersionId, userId } })
      : await prisma.comicWorkflowScriptVersion.findFirst({ where: { episodeId: episode.id, userId, status: "active" } });
    if (!script) return reply.code(400).send({ error: "请先激活脚本版本" });
    const chunks = shotChunks(script.scriptText);
    const rows = await prisma.$transaction(async (tx) => {
      if (body.data.replaceExisting) await tx.comicWorkflowShot.deleteMany({ where: { episodeId: episode.id, userId } });
      return Promise.all(chunks.map((chunk, index) => tx.comicWorkflowShot.create({
        data: {
          episodeId: episode.id,
          projectId: episode.projectId,
          userId,
          shotNo: index + 1,
          title: `镜头 ${index + 1}`,
          description: chunk,
          durationSec: 5,
        },
      })));
    });
    await prisma.comicWorkflowEpisode.update({ where: { id: episode.id }, data: { currentStage: "storyboard" } });
    return { success: true, data: rows.map(serializeShot) };
  });

  app.patch("/api/workflow/comics/shots/:shotId", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = shotParamsSchema.safeParse(req.params);
    const body = updateShotSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const shot = await prisma.comicWorkflowShot.findFirst({ where: { id: params.data.shotId, userId } });
    if (!shot) return reply.code(404).send({ error: "镜头不存在" });
    const row = await prisma.comicWorkflowShot.update({
      where: { id: shot.id },
      data: { ...body.data, ...(body.data.assetIds ? { assetIds: [...normalizeComicAssetIds(body.data.assetIds)] } : {}) },
    });
    return { success: true, data: serializeShot(row) };
  });

  app.delete("/api/workflow/comics/shots/:shotId", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = shotParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const shot = await prisma.comicWorkflowShot.findFirst({ where: { id: params.data.shotId, userId } });
    if (!shot) return reply.code(404).send({ error: "镜头不存在" });
    await prisma.comicWorkflowShot.delete({ where: { id: shot.id } });
    return { success: true };
  });

  app.post("/api/workflow/comics/shots/:shotId/generate-image", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = shotParamsSchema.safeParse(req.params);
    const body = generateImageSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const shot = await prisma.comicWorkflowShot.findFirst({ where: { id: params.data.shotId, userId }, include: { project: true } });
    if (!shot) return reply.code(404).send({ error: "镜头不存在" });
    const refs = shot.assetIds.length > 0
      ? await prisma.comicWorkflowAsset.findMany({ where: { id: { in: shot.assetIds }, projectId: shot.projectId, userId } })
      : [];
    const prompt = body.data.prompt || [
      shot.project.style,
      shot.title,
      shot.description,
      shot.dialogue,
      shot.camera,
      refs.map((asset) => `${asset.type}:${asset.name}:${asset.description}`).join("\n"),
    ].filter(Boolean).join("\n");
    try {
      const config = loadImageGenerationConfig(env);
      const image = await callImageGeneration({ config, prompt, size: body.data.size, fetchFn, env });
      const imageAssetId = await persistGeneratedImage({ prisma, fetchFn, env, userId, prompt, size: body.data.size, config, image });
      const row = await prisma.comicWorkflowShot.update({ where: { id: shot.id }, data: { imageAssetId }, include: { imageAsset: true } });
      return { success: true, data: serializeShot(row) };
    } catch (error) {
      return reply.code(502).send({ error: `镜头图片生成失败: ${errorMessage(error)}` });
    }
  });

  app.get("/api/workflow/comics/video/models", async () => ({ success: true, data: listComicVideoModels() }));

  app.post("/api/workflow/comics/shots/:shotId/generate-video", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = shotParamsSchema.safeParse(req.params);
    const body = generateVideoSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数不合法" });
    const shot = await prisma.comicWorkflowShot.findFirst({ where: { id: params.data.shotId, userId }, include: { imageAsset: true } });
    if (!shot) return reply.code(404).send({ error: "镜头不存在" });
    if (!shot.imageAsset) return reply.code(400).send({ error: "请先生成镜头图片" });
    try {
      const loaded = loadSeedanceConfig(env);
      const model = findComicVideoModel(body.data.modelId ?? loaded.model);
      const result = await submitSeedanceVideoTask({
        config: { ...loaded, model: model.id },
        fetchFn,
        imageUrl: shot.imageAsset.originalUrl,
        prompt: body.data.prompt ?? shot.description,
        durationSec: body.data.durationSec ?? Math.min(Math.max(shot.durationSec, model.minDurationSec), model.maxDurationSec),
        resolution: body.data.resolution ?? model.resolution,
      });
      const row = await prisma.comicWorkflowShot.update({
        where: { id: shot.id },
        data: { videoTaskId: result.taskId, videoStatus: result.status },
        include: { imageAsset: true },
      });
      return { success: true, data: serializeShot(row) };
    } catch (error) {
      return reply.code(502).send({ error: `视频任务创建失败: ${errorMessage(error)}` });
    }
  });

  app.post("/api/workflow/comics/shots/:shotId/poll-video", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = shotParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const shot = await prisma.comicWorkflowShot.findFirst({ where: { id: params.data.shotId, userId } });
    if (!shot) return reply.code(404).send({ error: "镜头不存在" });
    if (!shot.videoTaskId) return reply.code(400).send({ error: "镜头没有视频任务" });
    try {
      const result = await pollSeedanceVideoTask({ config: loadSeedanceConfig(env), fetchFn, taskId: shot.videoTaskId });
      const row = await prisma.comicWorkflowShot.update({
        where: { id: shot.id },
        data: {
          videoStatus: result.status,
          ...(result.videoUrl ? { videoUrl: result.videoUrl } : {}),
          ...(result.error ? { metadata: { videoError: result.error } } : {}),
        },
        include: { imageAsset: true },
      });
      return { success: true, data: serializeShot(row) };
    } catch (error) {
      return reply.code(502).send({ error: `视频状态刷新失败: ${errorMessage(error)}` });
    }
  });

  app.post("/api/workflow/comics/episodes/:episodeId/render", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = episodeParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参数不合法" });
    const episode = await prisma.comicWorkflowEpisode.findFirst({ where: { id: params.data.episodeId, userId } });
    if (!episode) return reply.code(404).send({ error: "剧集不存在" });
    const shots = await prisma.comicWorkflowShot.findMany({ where: { episodeId: episode.id, userId }, orderBy: { shotNo: "asc" } });
    const missing = shots.filter((shot) => !shot.videoUrl).map((shot) => shot.id);
    if (missing.length > 0) return reply.code(400).send({ error: "存在未完成视频的镜头", missingShotIds: missing });
    await prisma.comicWorkflowEpisode.update({ where: { id: episode.id }, data: { currentStage: "render" } });
    return {
      success: true,
      data: {
        episodeId: episode.id,
        status: "ready",
        totalDurationSec: shots.reduce((sum, shot) => sum + shot.durationSec, 0),
        segments: shots.map((shot) => ({ shotId: shot.id, shotNo: shot.shotNo, videoUrl: shot.videoUrl, durationSec: shot.durationSec })),
      },
    };
  });
}
