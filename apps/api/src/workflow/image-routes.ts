import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { deleteObject, getObject, loadS3Config, makeS3, type S3Config } from "../storage/s3.js";
import { imageGenerationResourceKey, imageResolutionFromSize, normalizeImageSize } from "./image-upstream-options.js";
import {
  callImageEdit as callImageEditService,
  callImageGeneration as callImageGenerationService,
  GPT_IMAGE_MODEL,
  IMAGE_GENERATION_MODELS,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
  QWEN_IMAGE_MODEL,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageGenerationConfig,
} from "./image-service.js";
import { loadOwnedReferenceImages } from "./ecom-route-helpers.js";
import { resolveImagePricing, type WorkflowResourcePriceRow } from "./workflow-pricing.js";

const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "mimo-v2.5-pro-ultraspeed";
const IMAGE_KEEP_LIMIT = 50;
const IMAGE_TASK_KEEP_LIMIT = 12;
const IMAGE_MAX_COUNT = 8;
const IMAGE_MAX_REFERENCE_COUNT = 3;
const IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_STALE_TASK_MS = DEFAULT_ATTEMPT_TIMEOUT_MS + DEFAULT_RETRY_DELAY_MS + 30_000;
const IMAGE_BLOB_URL_TTL_MS = 15 * 60_000;
const ECOM_IMAGE_REQUEST_PREFIX = "ecom-";
const IMAGE_TASK_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

const imageRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  model: z.enum(IMAGE_GENERATION_MODELS).default(QWEN_IMAGE_MODEL),
  prompt: z.string().trim().min(1).max(4000),
  size: z.string().trim().min(1).max(32).default("1024x1024"),
  resolution: z.enum(["1K", "2K"]).optional(),
  referenceAssetIds: z.array(z.string().trim().min(1).max(128)).max(IMAGE_MAX_REFERENCE_COUNT).default([]),
  count: z.number().int().min(1).max(IMAGE_MAX_COUNT),
});

const imageReferenceSchema = z.object({
  image: z.object({
    b64: z.string().trim().min(1),
    mime: z.string().trim().regex(/^image\/[A-Za-z0-9.+-]+$/).optional(),
  }),
});

const imageBlobParamsSchema = z.object({
  imageId: z.string().trim().min(1).max(128),
});

const imageBlobQuerySchema = z.object({
  exp: z.coerce.number().int().positive(),
  sig: z.string().trim().min(1).max(128),
});

type ImageGenerationRequest = z.infer<typeof imageRequestSchema>;

const optimizePromptSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

const imageTaskParamsSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});

interface BillingForImages {
  chargeResource: (args: { operationId: string; userId: string; resourceKey: string; units: number }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  reserve: (args: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (args: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number; cacheInputTokens?: number; cacheOutputTokens?: number }) => Promise<{ settled: number }>;
  listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

type ScheduleTask = (work: () => Promise<void>) => void;
type ImageTaskStatus = typeof IMAGE_TASK_STATUS[keyof typeof IMAGE_TASK_STATUS];
interface PromptOptimizationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheInputTokens?: number;
  readonly cacheOutputTokens?: number;
}

interface OptimizedPromptResult {
  readonly prompt: string;
  readonly model: string;
  readonly usage: PromptOptimizationUsage;
}

type PromptOptimizer = (prompt: string) => Promise<string | OptimizedPromptResult>;

interface ImageWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForImages;
  readonly fetchFn?: typeof fetch;
  readonly promptOptimizer?: PromptOptimizer;
  readonly scheduleTask?: ScheduleTask;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly staleTaskMs?: number;
  readonly loadStoredImage?: (objectKey: string) => Promise<Buffer>;
}

interface ImageGenerationTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly referenceAssetIds?: readonly string[];
  readonly count: number;
  readonly status: string;
  readonly completedCount: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
}

class ImageTaskStoppedError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status === IMAGE_TASK_STATUS.cancelled ? "用户已取消" : "任务已结束");
    this.name = "ImageTaskStoppedError";
    this.status = status;
  }
}

const activeGenerationTasks = new Map<string, AbortController>();

function tryLoadImageGenerationConfig(model?: string): ImageGenerationConfig | null {
  try {
    return model ? loadImageGenerationConfigForModel(model) : loadImageGenerationConfig();
  } catch {
    return null;
  }
}

function loadStaleTaskMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_STALE_TASK_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_TASK_MS;
}

export function loadImageAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

async function callImageGeneration(
  cfg: ImageGenerationConfig,
  prompt: string,
  size: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  return callImageGenerationService({ config: cfg, prompt, size, fetchFn, signal });
}

async function retryUntilSuccess<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ImageTaskStoppedError) throw error;
      if (options.maxAttempts && attempts >= options.maxAttempts) throw error;
      await options.onRetry?.(error, attempts);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
}

function tryLoadS3(env: NodeJS.ProcessEnv = process.env): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

async function pruneImages(prisma: PrismaClient, userId: string): Promise<void> {
  const oldRows = await prisma.imageAsset.findMany({
    where: { userId, NOT: { requestId: { startsWith: ECOM_IMAGE_REQUEST_PREFIX } } },
    orderBy: { createdAt: "desc" },
    skip: IMAGE_KEEP_LIMIT,
    select: { id: true, objectKey: true },
  });
  if (oldRows.length === 0) return;
  await prisma.imageAsset.deleteMany({ where: { id: { in: oldRows.map((row) => row.id) } } });
  const loaded = tryLoadS3();
  if (!loaded) return;
  await Promise.all(oldRows.map(async (row) => {
    if (row.objectKey) await deleteObject(loaded.s3, row.objectKey).catch(() => undefined);
  }));
}

async function listRecentImages(prisma: PrismaClient, userId: string) {
  return prisma.imageAsset.findMany({
    where: { userId, NOT: { requestId: { startsWith: ECOM_IMAGE_REQUEST_PREFIX } } },
    orderBy: { createdAt: "desc" },
    take: IMAGE_KEEP_LIMIT,
    select: {
      id: true,
      requestId: true,
      requestIndex: true,
      prompt: true,
      model: true,
      size: true,
      originalUrl: true,
      thumbnailUrl: true,
      objectKey: true,
      mime: true,
      createdAt: true,
    },
  });
}

function imageBlobSigningSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");
  return secret;
}

function imageBlobSignaturePayload(imageId: string, objectKey: string, exp: number): string {
  return `${imageId}\n${objectKey}\n${exp}`;
}

function imageBlobUrl(imageId: string, objectKey: string): string {
  const exp = Date.now() + IMAGE_BLOB_URL_TTL_MS;
  const sig = createHmac("sha256", imageBlobSigningSecret())
    .update(imageBlobSignaturePayload(imageId, objectKey, exp))
    .digest("base64url");
  const query = new URLSearchParams({ exp: String(exp), sig });
  return `/api/workflow/images/${encodeURIComponent(imageId)}/blob?${query.toString()}`;
}

function hasValidImageBlobAccess(imageId: string, objectKey: string, exp: number, sig: string): boolean {
  if (exp < Date.now()) return false;
  const expected = createHmac("sha256", imageBlobSigningSecret())
    .update(imageBlobSignaturePayload(imageId, objectKey, exp))
    .digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function serializeImageRow<Row extends {
  readonly id: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly objectKey?: string | null;
  readonly createdAt: Date;
}>(row: Row) {
  const { objectKey, createdAt, ...publicRow } = row;
  const blobUrl = objectKey ? imageBlobUrl(row.id, objectKey) : null;
  return {
    ...publicRow,
    originalUrl: blobUrl ?? row.originalUrl,
    thumbnailUrl: blobUrl ?? row.thumbnailUrl,
    createdAt: createdAt.toISOString(),
  };
}

function serializeTask(row: ImageGenerationTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    prompt: row.prompt,
    model: row.model,
    size: row.size,
    referenceAssetIds: [...(row.referenceAssetIds ?? [])],
    count: row.count,
    status: row.status as ImageTaskStatus,
    completedCount: row.completedCount,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function completedTaskFromAssets(
  userId: string,
  request: Omit<ImageGenerationRequest, "resolution">,
  cfg: ImageGenerationConfig,
  assets: readonly { readonly createdAt: Date; readonly model?: string }[],
): ImageGenerationTaskRow {
  const createdAt = assets[0]?.createdAt ?? new Date();
  return {
    id: `asset:${request.requestId}`,
    userId,
    requestId: request.requestId,
    prompt: request.prompt,
    model: assets[0]?.model ?? cfg.model,
    size: request.size,
    referenceAssetIds: request.referenceAssetIds,
    count: request.count,
    status: IMAGE_TASK_STATUS.completed,
    completedCount: Math.min(assets.length, request.count),
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}

async function listRecentTasks(prisma: PrismaClient, userId: string): Promise<ImageGenerationTaskRow[]> {
  return prisma.imageGenerationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: IMAGE_TASK_KEEP_LIMIT,
  });
}

function stripPromptFence(text: string): string {
  return text
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function estimatePromptOptimizationInputTokens(prompt: string): number {
  return Math.max(1, Math.ceil((prompt.length + 120) / 3));
}

function fallbackPromptOptimizationUsage(sourcePrompt: string, optimizedPrompt: string): PromptOptimizationUsage {
  return {
    inputTokens: estimatePromptOptimizationInputTokens(sourcePrompt),
    outputTokens: Math.max(1, Math.ceil(optimizedPrompt.length / 3)),
  };
}

function resolvePromptOptimizerModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.IMAGE_PROMPT_OPTIMIZER_MODEL ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL).trim()
    || DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL;
}

function normalizeOptimizedPromptResult(sourcePrompt: string, result: string | OptimizedPromptResult): OptimizedPromptResult {
  if (typeof result === "string") {
    return {
      prompt: result,
      model: resolvePromptOptimizerModel(),
      usage: fallbackPromptOptimizationUsage(sourcePrompt, result),
    };
  }
  return result;
}

async function optimizeImagePrompt(prompt: string): Promise<OptimizedPromptResult> {
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  const model = resolvePromptOptimizerModel();
  const response = await client.messages.create({
    model,
    max_tokens: 900,
    system: "你是商业图片生成提示词优化器。只输出优化后的中文提示词，不要解释，不要 Markdown。",
    messages: [{
      role: "user",
      content: `把下面的生图提示词优化成适合 Qwen Image 2.0 Pro 的高质量商业图片提示词。保留用户主体，不增加违背原意的元素，补充构图、光线、材质、风格和画面质量要求。\n\n原始提示词：${prompt}`,
    }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const optimized = stripPromptFence(text);
  if (!optimized) throw new Error("empty optimized prompt");
  const sliced = optimized.slice(0, 4000);
  const usage = response.usage;
  return {
    prompt: sliced,
    model,
    usage: {
      inputTokens: usage?.input_tokens ?? estimatePromptOptimizationInputTokens(prompt),
      outputTokens: usage?.output_tokens ?? Math.max(1, Math.ceil(sliced.length / 3)),
    },
  };
}

async function updateTask(
  prisma: PrismaClient,
  taskId: string,
  data: {
    readonly status?: ImageTaskStatus;
    readonly completedCount?: number;
    readonly error?: string | null;
  },
): Promise<void> {
  await prisma.imageGenerationTask.update({
    where: { id: taskId },
    data,
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "生成失败";
}

async function assertImageTaskRunning(prisma: PrismaClient, taskId: string): Promise<void> {
  const current = await prisma.imageGenerationTask.findUnique({ where: { id: taskId } });
  if (!current) throw new Error("image task not found");
  if (current.status !== IMAGE_TASK_STATUS.running) throw new ImageTaskStoppedError(current.status);
}

async function runImageGenerationTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly fetchFn: typeof fetch;
  readonly cfg: ImageGenerationConfig;
  readonly task: ImageGenerationTaskRow;
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly signal: AbortSignal;
  readonly onAttemptFailure?: (error: unknown, attempt: number) => void;
}): Promise<void> {
  const { prisma, billing, fetchFn, cfg, task } = args;
  const chargedOperationId = `image:${task.requestId}`;
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

    await Promise.all(missingIndexes.map(async (requestIndex) => {
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
        },
      });
      completedCount += 1;
      await updateTask(prisma, task.id, { completedCount, error: null });
    }));

    await assertImageTaskRunning(prisma, task.id);
    await pruneImages(prisma, task.userId);
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
      if (error.status === IMAGE_TASK_STATUS.cancelled) {
        await updateTask(prisma, task.id, {
          status: IMAGE_TASK_STATUS.cancelled,
          error: "用户已取消",
        }).catch(() => undefined);
      }
      return;
    }
    await billing.refundResource(chargedOperationId).catch(() => undefined);
    await updateTask(prisma, task.id, {
      status: IMAGE_TASK_STATUS.failed,
      error: safeErrorMessage(error),
    }).catch(() => undefined);
    throw error;
  }
}

function scheduleImageTask(scheduleTask: ScheduleTask, task: (signal: AbortSignal) => Promise<void>, requestId: string): void {
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

function isStaleRunningTask(task: ImageGenerationTaskRow, staleTaskMs: number, nowMs = Date.now()): boolean {
  return task.status === IMAGE_TASK_STATUS.running && nowMs - task.updatedAt.getTime() >= staleTaskMs;
}

async function claimStaleTask(prisma: PrismaClient, task: ImageGenerationTaskRow): Promise<ImageGenerationTaskRow | null> {
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

async function resumeStaleTasks(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
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
        billing: args.billing,
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

export async function imageWorkflowRoutes(app: FastifyInstance, deps: ImageWorkflowRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const fetchFn = deps.fetchFn ?? fetch;
  const loadStoredImage = deps.loadStoredImage ?? ((objectKey: string) => getObject(makeS3(loadS3Config()), objectKey));
  const promptOptimizer = deps.promptOptimizer ?? optimizeImagePrompt;
  const scheduleTask = deps.scheduleTask ?? ((work: () => Promise<void>) => {
    void work().catch((error) => app.log.error(error));
  });
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleTaskMs = deps.staleTaskMs ?? loadStaleTaskMs();

  async function resumeTasksIfNeeded(tasks: readonly ImageGenerationTaskRow[]): Promise<number> {
    return resumeStaleTasks({
      prisma,
      billing,
      fetchFn,
      tasks,
      scheduleTask,
      retryDelayMs,
      maxAttempts: deps.maxAttempts,
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

  app.get("/api/workflow/images", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const rows = await listRecentImages(prisma, userId);
    return { success: true, data: rows.map(serializeImageRow) };
  });

  app.post("/api/workflow/images/references", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = imageReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参考图参数不合法" });
    const bytes = Buffer.from(parsed.data.image.b64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) {
      return reply.code(400).send({ error: "参考图大小需在 10MB 以内" });
    }
    const mime = parsed.data.image.mime?.startsWith("image/") ? parsed.data.image.mime : "image/png";
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
        },
      });
      return { success: true, data: { asset: serializeImageRow(row) } };
    } catch (uploadError) {
      app.log.error(uploadError);
      return reply.code(502).send({ error: "上传参考图失败" });
    }
  });

  app.get("/api/workflow/images/pricing", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    try {
      return { success: true, data: await resolveImagePricing(billing) };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取生图计价失败" });
    }
  });

  app.get("/api/workflow/images/tasks", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    let rows = await listRecentTasks(prisma, userId);
    if (await resumeTasksIfNeeded(rows)) rows = await listRecentTasks(prisma, userId);
    return { success: true, data: rows.map(serializeTask) };
  });

  app.get("/api/workflow/images/state", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const [images, initialTasks] = await Promise.all([
      listRecentImages(prisma, userId),
      listRecentTasks(prisma, userId),
    ]);
    const tasks = await resumeTasksIfNeeded(initialTasks)
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

  app.post("/api/workflow/images/optimize-prompt", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const parsed = optimizePromptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "请输入提示词" });
    const sourcePrompt = parsed.data.prompt;
    const estimatedModel = resolvePromptOptimizerModel();
    const operationId = `image-prompt:${userId}:${randomUUID()}`;
    let reserved = false;
    try {
      await billing.reserve({
        operationId,
        userId,
        type: "image_prompt",
        model: estimatedModel,
        inputTokens: estimatePromptOptimizationInputTokens(sourcePrompt),
        maxOutputTokens: 900,
      });
      reserved = true;
      const optimized = normalizeOptimizedPromptResult(sourcePrompt, await promptOptimizer(sourcePrompt));
      await billing.settle({
        operationId,
        userId,
        model: optimized.model,
        inputTokens: optimized.usage.inputTokens,
        outputTokens: optimized.usage.outputTokens,
        cacheInputTokens: optimized.usage.cacheInputTokens,
        cacheOutputTokens: optimized.usage.cacheOutputTokens,
      });
      return { success: true, data: { prompt: optimized.prompt } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "积分不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      if (reserved) {
        await billing.settle({
          operationId,
          userId,
          model: estimatedModel,
          inputTokens: 0,
          outputTokens: 0,
        }).catch((settleError) => {
          app.log.error({ err: settleError, operationId }, "refund prompt optimization reservation failed");
        });
      }
      app.log.error(error);
      return reply.code(502).send({ error: "提示词优化暂时不可用" });
    }
  });

  app.post("/api/workflow/images/tasks/:requestId/cancel", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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

    const cancelled = await prisma.imageGenerationTask.updateMany({
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
    const existingImages = await prisma.imageAsset.findMany({
      where: { userId, requestId },
      orderBy: { requestIndex: "asc" },
    });
    if (cancelled.count === 1 && Math.max(task.completedCount, existingImages.length) === 0) {
      await billing.refundResource(`image:${requestId}`).catch((error) => {
        app.log.warn({ requestId, error: safeErrorMessage(error) }, "image task cancellation refund failed");
      });
    }
    return { success: true, data: { task: serializeTask(updated) } };
  });

  app.post("/api/workflow/images/generate", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
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
    const request = { ...parsed.data, size: normalizedSize, resolution };
    if (requestedModel === GPT_IMAGE_MODEL && request.referenceAssetIds.length > 0) {
      return reply.code(400).send({ error: "gpt-image-2 当前只接入了图片生成接口；参考图请切换到 Qwen Image" });
    }
    if (request.referenceAssetIds.length > 0) {
      const referenceAssets = await prisma.imageAsset.findMany({
        where: { userId, id: { in: [...request.referenceAssetIds] } },
        select: { id: true },
      });
      if (referenceAssets.length !== request.referenceAssetIds.length) {
        return reply.code(400).send({ error: "参考图不存在或无权使用" });
      }
    }
    const chargedOperationId = `image:${request.requestId}`;
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

    try {
      await billing.chargeResource({
        operationId: chargedOperationId,
        userId,
        resourceKey: imageGenerationResourceKey(request.resolution),
        units: request.count,
      });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "积分不足，请充值" });
      return reply.code(502).send({ error: "计费服务不可用" });
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
          count: request.count,
          status: IMAGE_TASK_STATUS.running,
          completedCount: existing.length,
          error: null,
        },
      });
    } catch (error) {
      await billing.refundResource(chargedOperationId).catch(() => undefined);
      app.log.error(error);
      return reply.code(500).send({ error: "创建生图任务失败" });
    }

    scheduleImageTask(scheduleTask, async (signal) => {
      await runImageGenerationTask({
        prisma,
        billing,
        fetchFn,
        cfg,
        task,
        retryDelayMs,
        maxAttempts: deps.maxAttempts,
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
