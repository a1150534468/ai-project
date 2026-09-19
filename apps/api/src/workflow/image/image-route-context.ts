import type { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import { createImageUrlSigner, type ImageUrlSigner } from "../../storage/cos-image-url.js";
import type { ImageGenerationTaskRow } from "./image-shared.js";
import { loadImageStaleTaskMs } from "./image-shared.js";
import {
  DEFAULT_RETRY_DELAY_MS,
  loadImageMaxAttempts,
  optimizeImagePrompt,
  safeErrorMessage,
} from "./image-route-helpers.js";
import { resumeStaleTasks } from "./image-task-runner.js";
import type { ImageWorkflowRouteDeps, PromptOptimizer, ScheduleTask } from "./image-route-types.js";

export interface ImageRouteContext {
  readonly app: FastifyInstance;
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly loadStoredImage: (objectKey: string) => Promise<Buffer>;
  readonly signImageUrl: ImageUrlSigner;
  readonly promptOptimizer: PromptOptimizer;
  readonly scheduleTask: ScheduleTask;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly staleTaskMs: number;
  readonly resumeStale: (tasks: readonly ImageGenerationTaskRow[]) => Promise<number>;
}

export function createImageRouteContext(app: FastifyInstance, deps: ImageWorkflowRouteDeps): ImageRouteContext {
  const prisma = deps.prisma ?? getPrisma();
  const fetchFn = deps.fetchFn ?? fetch;
  const scheduleTask = deps.scheduleTask ?? ((work) => void work().catch((error) => app.log.error(error)));
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = deps.maxAttempts ?? loadImageMaxAttempts();
  const staleTaskMs = deps.staleTaskMs ?? loadImageStaleTaskMs();

  const context = {
    app,
    prisma,
    fetchFn,
    signImageUrl: deps.signImageUrl ?? createImageUrlSigner(),
    loadStoredImage: deps.loadStoredImage
      ?? ((objectKey: string) => getObject(makeS3(loadS3Config()), objectKey)),
    promptOptimizer: deps.promptOptimizer ?? optimizeImagePrompt,
    scheduleTask,
    retryDelayMs,
    maxAttempts,
    staleTaskMs,
  };

  return {
    ...context,
    resumeStale: (tasks) => resumeStaleTasks({
      prisma,
      fetchFn,
      tasks,
      scheduleTask,
      retryDelayMs,
      maxAttempts,
      staleTaskMs,
      onResume: (task) => app.log.warn(
        { requestId: task.requestId },
        "resuming stale image generation task",
      ),
      onAttemptFailure: (task, error, attempt) => app.log.warn({
        requestId: task.requestId,
        attempt,
        error: safeErrorMessage(error),
      }, "image generation attempt failed; retrying"),
    }),
  };
}
