import { requireUser } from "../../auth/require-user.js";
import { imageResolutionFromSize, normalizeImageSize } from "../_shared/image-upstream-options.js";
import {
  IMAGE_MAX_REFERENCE_COUNT,
  loadImageGenerationConfigForModel,
  QWEN_IMAGE_MODEL,
  type ImageGenerationConfig,
} from "../_shared/image-service.js";
import type { ImageRouteContext } from "./image-route-context.js";
import {
  activeGenerationTasks,
  completedTaskFromAssets,
  imageRequestSchema,
  imageTaskParamsSchema,
  isUniqueConstraintError,
  listRecentImages,
  listRecentTasks,
  optimizePromptSchema,
  safeErrorMessage,
  serializeImageRow,
  serializeTask,
  type ImageGenerationRequest,
} from "./image-route-helpers.js";
import { IMAGE_TASK_STATUS, type ImageGenerationTaskRow } from "./image-shared.js";
import { runImageGenerationTask, scheduleImageTask } from "./image-task-runner.js";

async function ownedAssetsExist(
  context: ImageRouteContext,
  userId: string,
  assetIds: readonly string[],
): Promise<boolean> {
  if (assetIds.length === 0) return true;
  const rows = await context.prisma.imageAsset.findMany({
    where: { userId, id: { in: [...assetIds] } },
    select: { id: true },
  });
  return rows.length === assetIds.length;
}

function normalizeGenerationRequest(request: ImageGenerationRequest) {
  const size = normalizeImageSize(request.size);
  const sourceIds = request.sourceImageAssetId ? [request.sourceImageAssetId] : [];
  const referenceAssetIds = [...new Set([...sourceIds, ...request.referenceAssetIds])]
    .slice(0, IMAGE_MAX_REFERENCE_COUNT);
  return {
    ...request,
    size,
    referenceAssetIds,
    resolution: imageResolutionFromSize(size, request.resolution),
  };
}

async function generationResponseData(
  context: ImageRouteContext,
  userId: string,
  task: ImageGenerationTaskRow,
) {
  return {
    task: serializeTask(task),
    recent: (await listRecentImages(context.prisma, userId)).map(serializeImageRow),
  };
}

function queueGeneration(context: ImageRouteContext, cfg: ImageGenerationConfig, task: ImageGenerationTaskRow): void {
  scheduleImageTask(context.scheduleTask, async (signal) => {
    await runImageGenerationTask({
      prisma: context.prisma,
      fetchFn: context.fetchFn,
      cfg,
      task,
      retryDelayMs: context.retryDelayMs,
      maxAttempts: context.maxAttempts,
      signal,
      onAttemptFailure: (error, attempt) => context.app.log.warn({
        requestId: task.requestId,
        attempt,
        error: safeErrorMessage(error),
      }, "image generation attempt failed; retrying"),
    });
  }, task.requestId);
}

export function registerImageTaskRoutes(context: ImageRouteContext): void {
  const { app, prisma } = context;

  app.get("/api/workflow/images/tasks", { preHandler: requireUser }, async (req) => {
    let tasks = await listRecentTasks(prisma, req.userId);
    if (await context.resumeStale(tasks)) tasks = await listRecentTasks(prisma, req.userId);
    return { success: true, data: tasks.map(serializeTask) };
  });

  app.get("/api/workflow/images/state", { preHandler: requireUser }, async (req) => {
    const [images, initialTasks] = await Promise.all([
      listRecentImages(prisma, req.userId),
      listRecentTasks(prisma, req.userId),
    ]);
    const tasks = await context.resumeStale(initialTasks)
      ? await listRecentTasks(prisma, req.userId)
      : initialTasks;
    return {
      success: true,
      data: { images: images.map(serializeImageRow), tasks: tasks.map(serializeTask) },
    };
  });

  app.post("/api/workflow/images/optimize-prompt", { preHandler: requireUser }, async (req, reply) => {
    const parsed = optimizePromptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入提示词" });
    try {
      return { success: true, data: { prompt: await context.promptOptimizer(parsed.data.prompt) } };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "提示词优化暂时不可用" });
    }
  });

  app.post("/api/workflow/images/tasks/:requestId/cancel", { preHandler: requireUser }, async (req, reply) => {
    const parsed = imageTaskParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const { requestId } = parsed.data;
    const task = await prisma.imageGenerationTask.findFirst({ where: { userId: req.userId, requestId } });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (task.status === IMAGE_TASK_STATUS.cancelled) {
      return { success: true, data: { task: serializeTask(task) } };
    }
    if (task.status !== IMAGE_TASK_STATUS.running) {
      return reply.code(409).send({ error: "任务已结束，无法取消" });
    }

    const cancelled = await prisma.imageGenerationTask.updateMany({
      where: { id: task.id, userId: req.userId, requestId, status: IMAGE_TASK_STATUS.running },
      data: { status: IMAGE_TASK_STATUS.cancelled, error: "用户已取消" },
    });
    if (cancelled.count === 1) activeGenerationTasks.get(requestId)?.abort();

    const latest = await prisma.imageGenerationTask.findUnique({ where: { id: task.id } });
    if (!latest) return reply.code(404).send({ error: "任务不存在" });
    return { success: true, data: { task: serializeTask(latest) } };
  });

  app.post("/api/workflow/images/generate", { preHandler: requireUser }, async (req, reply) => {
    const parsed = imageRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    let cfg: ImageGenerationConfig;
    try {
      cfg = loadImageGenerationConfigForModel(parsed.data.model);
    } catch (error) {
      app.log.error({ err: error, model: parsed.data.model }, "image generation model is not configured");
      return reply.code(503).send({ error: `${parsed.data.model} 暂未配置` });
    }

    const request = normalizeGenerationRequest(parsed.data);
    if (request.model === QWEN_IMAGE_MODEL && request.resolution === "4K") {
      return reply.code(400).send({ error: "Qwen Image 2.0 Pro 最高支持 2K 输出" });
    }
    if (request.generationIntent !== "new" && !request.sourceImageAssetId) {
      return reply.code(400).send({ error: "修改或变体任务必须提供来源图片" });
    }
    if (request.sourceImageAssetId
      && !(await ownedAssetsExist(context, req.userId, [request.sourceImageAssetId]))) {
      return reply.code(400).send({ error: "来源图片不存在或无权使用" });
    }
    if (!(await ownedAssetsExist(context, req.userId, request.referenceAssetIds))) {
      return reply.code(400).send({ error: "参考图不存在或无权使用" });
    }

    const priorTask = await prisma.imageGenerationTask.findFirst({
      where: { userId: req.userId, requestId: request.requestId },
    });
    if (priorTask) {
      const statusCode = priorTask.status === IMAGE_TASK_STATUS.completed ? 200 : 202;
      return reply.code(statusCode).send({
        success: true,
        data: await generationResponseData(context, req.userId, priorTask),
      });
    }

    const existingAssets = await prisma.imageAsset.findMany({
      where: { userId: req.userId, requestId: request.requestId },
      orderBy: { requestIndex: "asc" },
    });
    if (existingAssets.length >= request.count) {
      const completed = completedTaskFromAssets(req.userId, request, cfg, existingAssets);
      return { success: true, data: await generationResponseData(context, req.userId, completed) };
    }

    let task: ImageGenerationTaskRow;
    try {
      task = await prisma.imageGenerationTask.create({
        data: {
          userId: req.userId,
          requestId: request.requestId,
          prompt: request.prompt,
          model: cfg.model,
          size: request.size,
          referenceAssetIds: request.referenceAssetIds,
          sourceImageAssetId: request.sourceImageAssetId ?? null,
          generationIntent: request.generationIntent,
          count: request.count,
          status: IMAGE_TASK_STATUS.running,
          completedCount: existingAssets.length,
          error: null,
        },
      }) as ImageGenerationTaskRow;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const winner = await prisma.imageGenerationTask.findFirst({
          where: { userId: req.userId, requestId: request.requestId },
        }) as ImageGenerationTaskRow | null;
        if (winner) {
          return reply.code(200).send({
            success: true,
            data: await generationResponseData(context, req.userId, winner),
          });
        }
        app.log.error({ err: error, requestId: request.requestId }, "image task requestId conflicts with another owner");
        return reply.code(409).send({ error: "该请求编号已被占用，请重试" });
      }
      app.log.error(error);
      return reply.code(500).send({ error: "创建生图任务失败" });
    }

    queueGeneration(context, cfg, task);
    return reply.code(202).send({
      success: true,
      data: await generationResponseData(context, req.userId, task),
    });
  });
}
