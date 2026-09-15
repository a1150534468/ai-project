/**
 * 拆分 image-routes.ts 时抽出的执行层：一张图一张图地跑上游、落库、推进任务行，
 * 以及卡单认领（`claimStaleTask` 的乐观锁）与开机续跑。
 *
 * 取消登记表 `activeGenerationTasks` 从 helpers import，绝不在本文件另建一份——
 * 否则 cancel 路由 abort 的是另一张表，取消会静默失效。
 */

import type { PrismaClient } from "@prisma/client";
import { loadOwnedReferenceImages } from "../_shared/reference-image.js";
import {
  callImageEdit as callImageEditService,
  isRetryableImageGenerationError,
  storeWorkflowImage as storeWorkflowImageService,
  type ImageGenerationConfig,
} from "../_shared/image-service.js";
import { IMAGE_TASK_STATUS, type ImageGenerationTaskRow } from "./image-shared.js";
import {
  activeGenerationTasks,
  assertImageTaskRunning,
  callImageGeneration,
  ImageTaskStoppedError,
  retryUntilSuccess,
  safeErrorMessage,
  tryLoadImageGenerationConfig,
  updateTask,
} from "./image-route-helpers.js";
import type { ScheduleTask } from "./image-route-types.js";

export async function runImageGenerationTask(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly cfg: ImageGenerationConfig;
  readonly task: ImageGenerationTaskRow;
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly signal: AbortSignal;
  readonly onAttemptFailure?: (error: unknown, attempt: number) => void;
}): Promise<void> {
  const { prisma, fetchFn, cfg, task } = args;
  try {
    await assertImageTaskRunning(prisma, task.id);
    const existing = await prisma.imageAsset.findMany({
      where: { userId: task.userId, requestId: task.requestId },
      orderBy: { requestIndex: "asc" },
    });
    const existingIndexes = new Set(existing.map((row) => row.requestIndex));
    const missingIndexes = Array.from({ length: task.count }, (_value, index) => index).filter((index) => !existingIndexes.has(index));
    const referenceAssetIds = task.referenceAssetIds ?? [];
    const referenceImages = referenceAssetIds.length > 0
      ? await loadOwnedReferenceImages(prisma, task.userId, referenceAssetIds, fetchFn)
      : null;
    let completedCount = existing.length;
    await updateTask(prisma, task.id, { status: IMAGE_TASK_STATUS.running, completedCount, error: null });

    // allSettled：任何分支失败也要等其余分支完全静止（含入库）再进入终态，避免漏记已入库图片
    const branchResults = await Promise.allSettled(missingIndexes.map(async (requestIndex) => {
      const stored = await retryUntilSuccess(async () => {
        await assertImageTaskRunning(prisma, task.id);
        const generated = referenceImages
          ? await callImageEditService({
              config: cfg,
              prompt: task.prompt,
              referenceImages,
              fetchFn,
              size: task.size,
              signal: args.signal,
            })
          : await callImageGeneration(cfg, task.prompt, task.size, fetchFn, args.signal);
        await assertImageTaskRunning(prisma, task.id);
        const storedImage = await storeWorkflowImageService({
          image: generated,
          userId: task.userId,
          requestId: task.requestId,
          requestIndex,
          fetchFn,
          signal: args.signal,
        });
        await assertImageTaskRunning(prisma, task.id);
        return storedImage;
      }, {
        retryDelayMs: args.retryDelayMs,
        maxAttempts: args.maxAttempts,
        shouldStop: (error) => !isRetryableImageGenerationError(error),
        onRetry: async (error, attempt) => {
          await assertImageTaskRunning(prisma, task.id);
          args.onAttemptFailure?.(error, attempt);
          await updateTask(prisma, task.id, {
            status: IMAGE_TASK_STATUS.running,
            error: `上次失败：${safeErrorMessage(error)}，${Math.round(args.retryDelayMs / 1000)} 秒后自动重试`,
          });
        },
      });
      await assertImageTaskRunning(prisma, task.id);
      await prisma.imageAsset.upsert({
        where: { requestId_requestIndex: { requestId: task.requestId, requestIndex } },
        update: {},
        create: {
          userId: task.userId,
          requestId: task.requestId,
          requestIndex,
          prompt: task.prompt,
          model: cfg.model,
          size: task.size,
          originalUrl: stored.originalUrl,
          thumbnailUrl: stored.thumbnailUrl,
          objectKey: stored.objectKey,
          mime: stored.mime,
          width: stored.width ?? null,
          height: stored.height ?? null,
        },
      });
      completedCount += 1;
      await updateTask(prisma, task.id, { completedCount, error: null });
    }));
    const branchFailures = branchResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (branchFailures.length > 0) {
      const stopped = branchFailures.find((failure) => failure.reason instanceof ImageTaskStoppedError);
      throw stopped ? stopped.reason : branchFailures[0].reason;
    }

    await assertImageTaskRunning(prisma, task.id);
    const generated = await prisma.imageAsset.findMany({
      where: { userId: task.userId, requestId: task.requestId },
      orderBy: { requestIndex: "asc" },
    });
    await updateTask(prisma, task.id, {
      status: IMAGE_TASK_STATUS.completed,
      completedCount: generated.length,
      error: null,
    });
  } catch (error) {
    if (error instanceof ImageTaskStoppedError) {
      return;
    }
    // 取消触发的 AbortError 会以普通错误抛出：任务已是 cancelled 时不得改写为 failed
    const latest = await prisma.imageGenerationTask.findUnique({ where: { id: task.id } }).catch(() => null);
    if (latest?.status === IMAGE_TASK_STATUS.cancelled) return;
    await updateTask(prisma, task.id, {
      status: IMAGE_TASK_STATUS.failed,
      error: safeErrorMessage(error),
    }).catch(() => undefined);
    throw error;
  }
}

export function scheduleImageTask(scheduleTask: ScheduleTask, task: (signal: AbortSignal) => Promise<void>, requestId: string): void {
  if (activeGenerationTasks.has(requestId)) return;
  const controller = new AbortController();
  activeGenerationTasks.set(requestId, controller);
  scheduleTask(async () => {
    try {
      await task(controller.signal);
    } finally {
      if (activeGenerationTasks.get(requestId) === controller) activeGenerationTasks.delete(requestId);
    }
  });
}

export function isStaleRunningTask(task: ImageGenerationTaskRow, staleTaskMs: number, nowMs = Date.now()): boolean {
  return task.status === IMAGE_TASK_STATUS.running && nowMs - task.updatedAt.getTime() >= staleTaskMs;
}

export async function claimStaleTask(prisma: PrismaClient, task: ImageGenerationTaskRow): Promise<ImageGenerationTaskRow | null> {
  const claimed = await prisma.imageGenerationTask.updateMany({
    where: {
      id: task.id,
      status: IMAGE_TASK_STATUS.running,
      updatedAt: task.updatedAt,
    },
    data: {
      error: task.error ?? "任务恢复中，将继续自动重试",
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.imageGenerationTask.findUnique({ where: { id: task.id } });
}

export async function resumeStaleTasks(args: {
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly tasks: readonly ImageGenerationTaskRow[];
  readonly scheduleTask: ScheduleTask;
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly staleTaskMs: number;
  readonly onResume: (task: ImageGenerationTaskRow) => void;
  readonly onAttemptFailure: (task: ImageGenerationTaskRow, error: unknown, attempt: number) => void;
}): Promise<number> {
  const staleTasks = args.tasks.filter((task) =>
    !activeGenerationTasks.has(task.requestId) && isStaleRunningTask(task, args.staleTaskMs)
  );
  const resumed = await Promise.all(staleTasks.map(async (task) => {
    const cfg = tryLoadImageGenerationConfig(task.model);
    if (!cfg) return 0;
    const claimed = await claimStaleTask(args.prisma, task);
    if (!claimed) return 0;
    args.onResume(claimed);
    scheduleImageTask(args.scheduleTask, async (signal) => {
      await runImageGenerationTask({
        prisma: args.prisma,
        fetchFn: args.fetchFn,
        cfg,
        task: claimed,
        retryDelayMs: args.retryDelayMs,
        maxAttempts: args.maxAttempts,
        signal,
        onAttemptFailure: (error, attempt) => args.onAttemptFailure(claimed, error, attempt),
      });
    }, claimed.requestId);
    return 1;
  }));
  return resumed.reduce<number>((sum, value) => sum + value, 0);
}
