/**
 * image 工作流的 fastify 插件。原本这一个文件是 1289 行（类型 + 工具 + 执行 + 路由），
 * P2.4 拆分后只留插件本体与对外导出，其余三层各自成文件：
 *
 * - `image-route-types.ts`   纯类型（ImageWorkflowRouteDeps / …）
 * - `image-route-helpers.ts` 无状态工具 + `activeGenerationTasks` 取消登记表
 * - `image-task-runner.ts`   跑图、卡单认领、开机续跑
 *
 * 对外导出面与拆分前逐字一致，仍旧只有三个：`imageWorkflowRoutes`、`loadImageMaxAttempts`、
 * `loadImageAttemptTimeoutMs`。`image-routes.test.ts` 与 `index.ts` 因此一行都不用改；
 * 往这里补新的 re-export 等于悄悄放大契约，别加。
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import { imageResolutionFromSize, normalizeImageSize } from "../_shared/image-upstream-options.js";
import { startImageReaper } from "./image-reaper.js";
import {
  IMAGE_TASK_STATUS,
  type ImageGenerationTaskRow,
  loadImageStaleTaskMs,
} from "./image-shared.js";
import {
  IMAGE_MAX_REFERENCE_COUNT,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  loadImageAttemptTimeoutMs,
  loadImageGenerationConfigForModel,
  QWEN_IMAGE_MODEL,
  storeWorkflowImage as storeWorkflowImageService,
  type ImageGenerationConfig,
} from "../_shared/image-service.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import type { ImageWorkflowRouteDeps } from "./image-route-types.js";
import {
  activeGenerationTasks,
  completedTaskFromAssets,
  DEFAULT_RETRY_DELAY_MS,
  hasValidImageBlobAccess,
  imageBlobParamsSchema,
  imageBlobQuerySchema,
  imageReferenceSchema,
  imageRequestSchema,
  imageTaskParamsSchema,
  isUniqueConstraintError,
  listRecentImages,
  listRecentTasks,
  loadImageMaxAttempts,
  optimizeImagePrompt,
  optimizePromptSchema,
  safeErrorMessage,
  serializeImageRow,
  serializeTask,
} from "./image-route-helpers.js";
import { resumeStaleTasks, runImageGenerationTask, scheduleImageTask } from "./image-task-runner.js";

// 与 `_shared/image-service.ts` 的实现逐字节重复（P0.4 记录里标的那处），本次去重后
// 只保留一份，这里转出去是为了不动 `image-routes.test.ts` 与其他既有引用点。
export { loadImageAttemptTimeoutMs };

export { loadImageMaxAttempts };

export async function imageWorkflowRoutes(app: FastifyInstance, deps: ImageWorkflowRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const fetchFn = deps.fetchFn ?? fetch;
  const loadStoredImage = deps.loadStoredImage ?? ((objectKey: string) => getObject(makeS3(loadS3Config()), objectKey));
  const promptOptimizer = deps.promptOptimizer ?? optimizeImagePrompt;
  const scheduleTask = deps.scheduleTask ?? ((work: () => Promise<void>) => {
    void work().catch((error) => app.log.error(error));
  });
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  // Keep ordinary image jobs bounded as well. A missing dependency injection
  // value must not turn a persistent 429/timeout into an infinite background
  // task; callers can still choose a different bounded value explicitly.
  const maxAttempts = deps.maxAttempts ?? loadImageMaxAttempts();
  const staleTaskMs = deps.staleTaskMs ?? loadImageStaleTaskMs();

  /**
   * 被动路径：轮询接口顺手把自己这批行救一下。主动扫走的是 reaper，各扫各的查询——
   * 两条路撞上同一行时靠 claimStaleTask 的乐观锁定胜负，只有一边能拉起来。
   */
  async function resumeTasksIfStale(tasks: readonly ImageGenerationTaskRow[]): Promise<number> {
    return resumeStaleTasks({
      prisma,
      fetchFn,
      tasks,
      scheduleTask,
      retryDelayMs,
      maxAttempts,
      staleTaskMs,
      onResume: (task) => {
        app.log.warn({ requestId: task.requestId }, "resuming stale image generation task");
      },
      onAttemptFailure: (task, error, attempt) => {
        app.log.warn({
          requestId: task.requestId,
          attempt,
          error: safeErrorMessage(error),
        }, "image generation attempt failed; retrying");
      },
    });
  }

  if (deps.redis) {
    const timer = startImageReaper({
      prisma,
      redis: deps.redis,
      resume: resumeTasksIfStale,
      onError: (error) => app.log.error({ err: error }, "image reaper tick failed"),
    });
    // 必须清：插件可以被反复注册（测试、多实例 fastify），漏了就攒定时器。
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }

  app.get("/api/workflow/images/:imageId/blob", async (req, reply) => {
    const params = imageBlobParamsSchema.safeParse(req.params);
    const query = imageBlobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const image = await prisma.imageAsset.findUnique({
      where: { id: params.data.imageId },
      select: { id: true, objectKey: true, mime: true },
    });
    if (!image?.objectKey) return reply.code(404).send({ error: "图片不存在" });
    if (!hasValidImageBlobAccess(image.id, image.objectKey, query.data.exp, query.data.sig)) {
      return reply.code(401).send({ error: "图片地址已失效" });
    }
    try {
      const buffer = await loadStoredImage(image.objectKey);
      const mime = image.mime.startsWith("image/") ? image.mime : "image/png";
      return reply.header("Cache-Control", "private, max-age=300").type(mime).send(buffer);
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.get("/api/workflow/images", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const rows = await listRecentImages(prisma, userId);
    return { success: true, data: rows.map(serializeImageRow) };
  });

  app.post("/api/workflow/images/references", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const parsed = imageReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参考图参数不合法" });
    const bytes = Buffer.from(parsed.data.image.b64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
      return reply.code(400).send({ error: "参考图大小需在 10MB 以内" });
    }
    const mime = (parsed.data.image.mime?.split(";", 1)[0]?.trim().toLowerCase() || "image/png");
    if (!IMAGE_REFERENCE_MIME_TYPES.has(mime)) {
      return reply.code(400).send({ error: "参考图仅支持 JPG、PNG、WEBP、BMP、TIFF 或 GIF" });
    }
    try {
      const sharp = await loadSharp();
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("missing dimensions");
    } catch {
      return reply.code(400).send({ error: "参考图不是可读取的图片，或像素尺寸过大" });
    }
    const requestId = `ecom-reference:${randomUUID()}`;
    try {
      const stored = await storeWorkflowImageService({
        image: { kind: "b64", b64: parsed.data.image.b64, mime },
        userId,
        requestId,
        requestIndex: 0,
        fetchFn,
      });
      const row = await prisma.imageAsset.create({
        data: {
          userId,
          requestId,
          requestIndex: 0,
          prompt: "image_reference_upload",
          model: "image_reference_upload",
          size: "reference",
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
          objectKey: stored.objectKey,
          mime: stored.mime,
          width: stored.width ?? null,
          height: stored.height ?? null,
        },
      });
      return { success: true, data: { asset: serializeImageRow(row) } };
    } catch (uploadError) {
      app.log.error(uploadError);
      return reply.code(502).send({ error: "上传参考图失败" });
    }
  });

  app.get("/api/workflow/images/tasks", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    let rows = await listRecentTasks(prisma, userId);
    if (await resumeTasksIfStale(rows)) rows = await listRecentTasks(prisma, userId);
    return { success: true, data: rows.map(serializeTask) };
  });

  app.get("/api/workflow/images/state", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const [images, initialTasks] = await Promise.all([
      listRecentImages(prisma, userId),
      listRecentTasks(prisma, userId),
    ]);
    const tasks = await resumeTasksIfStale(initialTasks)
      ? await listRecentTasks(prisma, userId)
      : initialTasks;
    return {
      success: true,
      data: {
        images: images.map(serializeImageRow),
        tasks: tasks.map(serializeTask),
      },
    };
  });

  app.post("/api/workflow/images/optimize-prompt", { preHandler: requireUser }, async (req, reply) => {
    const parsed = optimizePromptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入提示词" });
    const sourcePrompt = parsed.data.prompt;
    try {
      const optimized = await promptOptimizer(sourcePrompt);
      return { success: true, data: { prompt: optimized } };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "提示词优化暂时不可用" });
    }
  });

  app.post("/api/workflow/images/tasks/:requestId/cancel", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const parsed = imageTaskParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const { requestId } = parsed.data;
    const task = await prisma.imageGenerationTask.findFirst({
      where: { userId, requestId },
    });
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (task.status === IMAGE_TASK_STATUS.cancelled) {
      return { success: true, data: { task: serializeTask(task) } };
    }
    if (task.status !== IMAGE_TASK_STATUS.running) {
      return reply.code(409).send({ error: "任务已结束，无法取消" });
    }

    await prisma.imageGenerationTask.updateMany({
      where: {
        id: task.id,
        userId,
        requestId,
        status: IMAGE_TASK_STATUS.running,
      },
      data: {
        status: IMAGE_TASK_STATUS.cancelled,
        error: "用户已取消",
      },
    });
    activeGenerationTasks.get(requestId)?.abort();
    const updated = await prisma.imageGenerationTask.findUnique({ where: { id: task.id } });
    if (!updated) return reply.code(404).send({ error: "任务不存在" });
    return { success: true, data: { task: serializeTask(updated) } };
  });

  app.post("/api/workflow/images/generate", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const parsed = imageRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });

    const requestedModel = parsed.data.model;
    let cfg: ImageGenerationConfig;
    try {
      cfg = loadImageGenerationConfigForModel(requestedModel);
    } catch (configError) {
      app.log.error({ err: configError, model: requestedModel }, "image generation model is not configured");
      return reply.code(503).send({ error: `${requestedModel} 暂未配置` });
    }
    const normalizedSize = normalizeImageSize(parsed.data.size);
    const resolution = imageResolutionFromSize(normalizedSize, parsed.data.resolution);
    if (requestedModel === QWEN_IMAGE_MODEL && resolution === "4K") {
      return reply.code(400).send({ error: "Qwen Image 2.0 Pro 最高支持 2K 输出" });
    }
    if (parsed.data.generationIntent !== "new" && !parsed.data.sourceImageAssetId) {
      return reply.code(400).send({ error: "修改或变体任务必须提供来源图片" });
    }
    const sourceImageAssetId = parsed.data.sourceImageAssetId;
    if (sourceImageAssetId) {
      const sourceAssets = await prisma.imageAsset.findMany({
        where: { userId, id: { in: [sourceImageAssetId] } },
        select: { id: true },
      });
      if (sourceAssets.length !== 1) {
        return reply.code(400).send({ error: "来源图片不存在或无权使用" });
      }
    }
    const referenceAssetIds = Array.from(new Set([
      ...(sourceImageAssetId ? [sourceImageAssetId] : []),
      ...parsed.data.referenceAssetIds,
    ])).slice(0, IMAGE_MAX_REFERENCE_COUNT);
    const request = { ...parsed.data, sourceImageAssetId, referenceAssetIds, size: normalizedSize, resolution };
    if (request.referenceAssetIds.length > 0) {
      const referenceAssets = await prisma.imageAsset.findMany({
        where: { userId, id: { in: [...request.referenceAssetIds] } },
        select: { id: true },
      });
      if (referenceAssets.length !== request.referenceAssetIds.length) {
        return reply.code(400).send({ error: "参考图不存在或无权使用" });
      }
    }
    const existingTask = await prisma.imageGenerationTask.findFirst({
      where: { userId, requestId: request.requestId },
    });
    if (existingTask) {
      const recent = await listRecentImages(prisma, userId);
      return reply.code(existingTask.status === IMAGE_TASK_STATUS.completed ? 200 : 202).send({
        success: true,
        data: {
          task: serializeTask(existingTask),
          recent: recent.map(serializeImageRow),
        },
      });
    }

    const existing = await prisma.imageAsset.findMany({
      where: { userId, requestId: request.requestId },
      orderBy: { requestIndex: "asc" },
    });
    if (existing.length >= request.count) {
      const recent = await listRecentImages(prisma, userId);
      return {
        success: true,
        data: {
          task: serializeTask(completedTaskFromAssets(userId, request, cfg, existing)),
          recent: recent.map(serializeImageRow),
        },
      };
    }

    let task: ImageGenerationTaskRow;
    try {
      task = await prisma.imageGenerationTask.create({
        data: {
          userId,
          requestId: request.requestId,
          prompt: request.prompt,
          model: cfg.model,
          size: request.size,
          referenceAssetIds: request.referenceAssetIds,
          sourceImageAssetId: request.sourceImageAssetId ?? null,
          generationIntent: request.generationIntent,
          count: request.count,
          status: IMAGE_TASK_STATUS.running,
          completedCount: existing.length,
          error: null,
        },
      });
    } catch (error) {
      // 并发重复提交：requestId 唯一键冲突说明另一次请求已建单，把赢家那一行原样返回
      if (isUniqueConstraintError(error)) {
        const winner = await prisma.imageGenerationTask.findFirst({
          where: { userId, requestId: request.requestId },
        }) as unknown as ImageGenerationTaskRow | null;
        if (winner) {
          const recent = await listRecentImages(prisma, userId);
          return reply.code(200).send({
            success: true,
            data: {
              task: serializeTask(winner),
              recent: recent.map(serializeImageRow),
            },
          });
        }
        app.log.error({ err: error, requestId: request.requestId }, "image task requestId conflicts with another owner");
        return reply.code(409).send({ error: "该请求编号已被占用，请重试" });
      }
      app.log.error(error);
      return reply.code(500).send({ error: "创建生图任务失败" });
    }

    scheduleImageTask(scheduleTask, async (signal) => {
      await runImageGenerationTask({
        prisma,
        fetchFn,
        cfg,
        task,
        retryDelayMs,
        maxAttempts,
        signal,
        onAttemptFailure: (error, attempt) => {
          app.log.warn({
            requestId: task.requestId,
            attempt,
            error: safeErrorMessage(error),
          }, "image generation attempt failed; retrying");
        },
      });
    }, task.requestId);

    const recent = await listRecentImages(prisma, userId);
    return reply.code(202).send({
      success: true,
      data: {
        task: serializeTask(task),
        recent: recent.map(serializeImageRow),
      },
    });
  });
}
