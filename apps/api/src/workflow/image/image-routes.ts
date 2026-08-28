import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { deleteObject, getObject, loadS3Config, makeS3, type S3Config } from "../../storage/s3.js";
import {
  imageGenerationResourceKey,
  imageResolutionFromSize,
  imageSizeForResolution,
  normalizeImageSize,
} from "../_shared/image-upstream-options.js";
import { deliveredImageResolution, minDeliveredPixels, pixelsFromSize } from "../_shared/image-delivered-tier.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import { startImageReaper } from "./image-reaper.js";
import {
  IMAGE_TASK_STATUS,
  type ImageGenerationTaskRow,
  imageReservationTtlSeconds,
  loadImageStaleTaskMs,
  SETTLING_STALE_MS,
} from "./image-shared.js";
import {
  resolveImageChargeRow,
  resolveImagePricingMatrix,
  type WorkflowResourcePriceRow,
} from "../_shared/workflow-pricing.js";
import {
  callImageEdit as callImageEditService,
  callImageGeneration as callImageGenerationService,
  IMAGE_GENERATION_MODELS,
  IMAGE_MAX_REFERENCE_COUNT,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  isRetryableImageGenerationError,
  loadImageAttemptTimeoutMs,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
  QWEN_IMAGE_MODEL,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageGenerationConfig,
} from "../_shared/image-service.js";
import { loadOwnedReferenceImages } from "../_shared/reference-image.js";
import { loadSharp } from "../../runtime/resource-limits.js";

const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "mimo-v2.5-pro-ultraspeed";
const IMAGE_KEEP_LIMIT = 50;
const IMAGE_TASK_KEEP_LIMIT = 12;
const IMAGE_MAX_COUNT = 8;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 3;
const IMAGE_BLOB_URL_TTL_MS = 15 * 60_000;
const ECOM_IMAGE_REQUEST_PREFIX = "ecom-";
const IMAGE_GENERATION_INTENTS = ["new", "variation", "edit"] as const;
const imageRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  model: z.enum(IMAGE_GENERATION_MODELS).default(QWEN_IMAGE_MODEL),
  prompt: z.string().trim().min(1).max(4000),
  size: z.string().trim().min(1).max(32).default("1024x1024"),
  resolution: z.enum(["1K", "2K"]).optional(),
  // Normalize and truncate after inserting the source image. The client normally
  // sends at most three, but accepting a few duplicates here keeps the contract
  // compatible with older callers that relied on server-side de-duplication.
  referenceAssetIds: z.array(z.string().trim().min(1).max(128)).max(16).default([]),
  sourceImageAssetId: z.string().trim().min(1).max(128).optional(),
  generationIntent: z.enum(IMAGE_GENERATION_INTENTS).default("new"),
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

const imagePricingQuerySchema = z.object({
  model: z.string().trim().min(1).max(128).optional(),
});

interface BillingForImages {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number; reservationTtlSeconds?: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
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
  /**
   * 给了才起主动扫的定时器。留成可选是为了让既有测试注册插件时不需要 redis，
   * 也避免测试进程里凭空多一个后台定时器。生产在 server.ts 注入。
   */
  readonly redis?: Redis;
}

interface RetryOptions {
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (error: unknown, attempt: number) => Promise<void>;
  readonly shouldStop?: (error: unknown) => boolean;
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

// 与 `_shared/image-service.ts` 的实现逐字节重复（P0.4 记录里标的那处），本次去重后
// 只保留一份，这里转出去是为了不动 `image-routes.test.ts` 与其他既有引用点。
export { loadImageAttemptTimeoutMs };

export function loadImageMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? Math.min(10, value) : DEFAULT_MAX_ATTEMPTS;
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
      if (options.shouldStop?.(error)) throw error;
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
  const generationIntent = IMAGE_GENERATION_INTENTS.includes(row.generationIntent as typeof IMAGE_GENERATION_INTENTS[number])
    ? row.generationIntent as typeof IMAGE_GENERATION_INTENTS[number]
    : "new";
  return {
    id: row.id,
    requestId: row.requestId,
    prompt: row.prompt,
    model: row.model,
    size: row.size,
    referenceAssetIds: [...(row.referenceAssetIds ?? [])],
    sourceImageAssetId: row.sourceImageAssetId ?? null,
    generationIntent,
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
    sourceImageAssetId: request.sourceImageAssetId ?? null,
    generationIntent: request.generationIntent,
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
  return errorMessageOrFallback(error, "生成失败");
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

async function assertImageTaskRunning(prisma: PrismaClient, taskId: string): Promise<void> {
  const current = await prisma.imageGenerationTask.findUnique({ where: { id: taskId } });
  if (!current) throw new Error("image task not found");
  if (current.status !== IMAGE_TASK_STATUS.running) throw new ImageTaskStoppedError(current.status);
}

type ImageTaskTerminalReason = "completed" | "failed" | "cancelled";

/**
 * 任务终态统一结算（完成 / 失败 / 取消共用）：
 * - reserve 任务：先原子认领（reserved/settle_failed → settling），并发调用只有 count===1 的一方真正结算；
 *   按实际入库张数结算；0 张则整单退款；计费接口出错记 settle_failed，由对账重试。
 * - legacy charge 任务（升级前创建、已先扣费）：完全保留旧语义——失败全额退款，取消仅在 0 张时退款。
 */
/**
 * 按实际交付像素定结算档位：中转上游常常只认宽高比、忽略绝对像素，
 * 请求 2K 却回 1K 尺寸时若按请求档收就是多收一倍。取一批图里最小的那张，宁可少收。
 */
async function resolveImageSettleKey(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly task: ImageGenerationTaskRow;
  readonly outputs: readonly { readonly width: number | null; readonly height: number | null }[];
  readonly requestedKey: string;
}): Promise<{ readonly resourceKey: string }> {
  const fallback = { resourceKey: args.requestedKey };
  try {
    const requested = imageResolutionFromSize(args.task.size);
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels: minDeliveredPixels(args.outputs.map((output) => `${output.width ?? 0}x${output.height ?? 0}`)),
      pixelsForResolution: (resolution) => pixelsFromSize(imageSizeForResolution(args.task.size, resolution)),
    });
    if (settled === requested) return fallback;
    const rows = args.billing.listResourcePrices ? (await args.billing.listResourcePrices()).data ?? [] : [];
    const row = resolveImageChargeRow(rows, { resolution: settled, model: args.task.model });
    return { resourceKey: row.resourceKey };
  } catch {
    return fallback;
  }
}

async function settleImageTaskBilling(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly taskId: string;
  readonly reason: ImageTaskTerminalReason;
  readonly onBillingError?: (error: unknown, operationId: string) => void;
}): Promise<void> {
  const { prisma, billing } = args;
  const current = await prisma.imageGenerationTask.findUnique({ where: { id: args.taskId } }) as unknown as ImageGenerationTaskRow | null;
  if (!current) return;
  const operationId = `image:${current.requestId}`;
  if (current.billingMode !== "reserve") {
    const legacyStored = await prisma.imageAsset.findMany({
      where: { userId: current.userId, requestId: current.requestId },
      select: { id: true },
    });
    if (args.reason === "failed" || (args.reason === "cancelled" && legacyStored.length === 0)) {
      await billing.refundResource(operationId).catch((error) => args.onBillingError?.(error, operationId));
    }
    return;
  }
  const claimed = await prisma.imageGenerationTask.updateMany({
    where: { id: current.id, billingStatus: { in: ["reserved", "settle_failed"] } },
    data: { billingStatus: "settling" },
  });
  if (claimed.count !== 1) return;
  try {
    // 以真实入库的图片数为准，不信任内存里的 completedCount
    const storedImages = await prisma.imageAsset.findMany({
      where: { userId: current.userId, requestId: current.requestId },
      select: { id: true, width: true, height: true },
    });
    const completedCount = storedImages.length;
    if (completedCount > 0) {
      const requestedKey = current.billingResourceKey
        ?? imageGenerationResourceKey(imageResolutionFromSize(current.size));
      const settle = await resolveImageSettleKey({ prisma, billing, task: current, outputs: storedImages, requestedKey });
      await billing.settleResource({ operationId, resourceKey: settle.resourceKey, units: completedCount });
      await prisma.imageGenerationTask.update({
        where: { id: current.id },
        data: { billingStatus: "settled", billingSettledUnits: completedCount, billingResourceKey: settle.resourceKey },
      });
    } else {
      await billing.refundResource(operationId);
      await prisma.imageGenerationTask.update({
        where: { id: current.id },
        data: { billingStatus: "refunded", billingSettledUnits: 0 },
      });
    }
  } catch (error) {
    args.onBillingError?.(error, operationId);
    await prisma.imageGenerationTask.update({
      where: { id: current.id },
      data: { billingStatus: "settle_failed" },
    }).catch(() => undefined);
  }
}

function terminalReasonOf(status: string): ImageTaskTerminalReason | null {
  if (status === IMAGE_TASK_STATUS.completed) return "completed";
  if (status === IMAGE_TASK_STATUS.failed) return "failed";
  if (status === IMAGE_TASK_STATUS.cancelled) return "cancelled";
  return null;
}

/**
 * 对账：终态但预留未落地的任务（settle_failed / 崩在 settling / 状态已写但结算前进程挂掉留下的 reserved）
 * 重跑一次统一结算。operationId 由 requestId 决定，重放对计费侧是幂等的。
 */
async function reconcilePendingImageBilling(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForImages;
  readonly tasks: readonly ImageGenerationTaskRow[];
  readonly nowMs?: number;
  readonly onReconcile?: (task: ImageGenerationTaskRow) => void;
  readonly onBillingError?: (task: ImageGenerationTaskRow, error: unknown, operationId: string) => void;
}): Promise<number> {
  const nowMs = args.nowMs ?? Date.now();
  const pending = args.tasks.filter((task) => {
    if (task.billingMode !== "reserve") return false;
    if (!terminalReasonOf(task.status)) return false;
    if (task.billingStatus === "reserved" || task.billingStatus === "settle_failed") return true;
    return task.billingStatus === "settling" && nowMs - task.updatedAt.getTime() >= SETTLING_STALE_MS;
  });
  if (pending.length === 0) return 0;
  const reconciled = await Promise.all(pending.map(async (task) => {
    if (task.billingStatus === "settling") {
      // 只有确实卡住的 settling 才回退，避免抢走仍在结算的调用方
      const released = await args.prisma.imageGenerationTask.updateMany({
        where: {
          id: task.id,
          billingStatus: "settling",
          updatedAt: { lt: new Date(nowMs - SETTLING_STALE_MS) },
        },
        data: { billingStatus: "reserved" },
      });
      if (released.count !== 1) return 0;
    }
    args.onReconcile?.(task);
    await settleImageTaskBilling({
      prisma: args.prisma,
      billing: args.billing,
      taskId: task.id,
      reason: terminalReasonOf(task.status) ?? "failed",
      onBillingError: (error, operationId) => args.onBillingError?.(task, error, operationId),
    }).catch(() => undefined);
    return 1;
  }));
  return reconciled.reduce<number>((sum, value) => sum + value, 0);
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
  readonly onBillingError?: (error: unknown, operationId: string) => void;
}): Promise<void> {
  const { prisma, billing, fetchFn, cfg, task } = args;
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

    // allSettled：任何分支失败也要等其余分支完全静止（含入库）再进入终态结算，避免少算已入库图片
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
    await settleImageTaskBilling({
      prisma,
      billing,
      taskId: task.id,
      reason: "completed",
      onBillingError: args.onBillingError,
    });
  } catch (error) {
    if (error instanceof ImageTaskStoppedError) {
      // 取消由 cancel 路由负责结算，这里只兜底刷新状态
      if (error.status === IMAGE_TASK_STATUS.cancelled) {
        await updateTask(prisma, task.id, {
          status: IMAGE_TASK_STATUS.cancelled,
          error: "用户已取消",
        }).catch(() => undefined);
      }
      return;
    }
    // 取消触发的 AbortError 会以普通错误抛出：任务已是 cancelled 时不得改写为 failed，也不结算（取消路由负责）
    const latest = await prisma.imageGenerationTask.findUnique({ where: { id: task.id } }).catch(() => null);
    if (latest?.status === IMAGE_TASK_STATUS.cancelled) return;
    await updateTask(prisma, task.id, {
      status: IMAGE_TASK_STATUS.failed,
      error: safeErrorMessage(error),
    }).catch(() => undefined);
    await settleImageTaskBilling({
      prisma,
      billing,
      taskId: task.id,
      reason: "failed",
      onBillingError: args.onBillingError,
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
  readonly onBillingError?: (task: ImageGenerationTaskRow, error: unknown, operationId: string) => void;
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
        onBillingError: (error, operationId) => args.onBillingError?.(claimed, error, operationId),
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
  // Keep ordinary image jobs bounded as well. A missing dependency injection
  // value must not turn a persistent 429/timeout into an infinite background
  // task; callers can still choose a different bounded value explicitly.
  const maxAttempts = deps.maxAttempts ?? loadImageMaxAttempts();
  const staleTaskMs = deps.staleTaskMs ?? loadImageStaleTaskMs();

  async function reconcileTasksBilling(tasks: readonly ImageGenerationTaskRow[]): Promise<number> {
    return reconcilePendingImageBilling({
      prisma,
      billing,
      tasks,
      onReconcile: (task) => {
        app.log.warn({
          requestId: task.requestId,
          billingStatus: task.billingStatus,
        }, "retrying pending image task billing settlement");
      },
      onBillingError: (task, error, operationId) => {
        app.log.error({ requestId: task.requestId, operationId, err: error }, "image task billing reconciliation failed");
      },
    });
  }

  async function resumeTasksIfStale(tasks: readonly ImageGenerationTaskRow[]): Promise<number> {
    return resumeStaleTasks({
      prisma,
      billing,
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
      onBillingError: (task, error, operationId) => {
        app.log.error({ requestId: task.requestId, operationId, err: error }, "image task billing settlement failed");
      },
    });
  }

  /**
   * 被动路径：轮询接口顺手把自己这批行救一下。两趟合起来算，行为与拆分前一致。
   * 主动扫走的是 reaper，各扫各的查询——两条路撞上同一行时靠 claimStaleTask 的
   * 乐观锁和 settleImageTaskBilling 的 settling 抢占定胜负，不会双花。
   */
  async function resumeTasksIfNeeded(tasks: readonly ImageGenerationTaskRow[]): Promise<number> {
    const reconciled = await reconcileTasksBilling(tasks);
    const resumed = await resumeTasksIfStale(tasks);
    return reconciled + resumed;
  }

  if (deps.redis) {
    const timer = startImageReaper({
      prisma,
      redis: deps.redis,
      resume: resumeTasksIfStale,
      reconcile: reconcileTasksBilling,
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

  app.get("/api/workflow/images/pricing", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const query = imagePricingQuerySchema.safeParse(req.query);
    const model = query.success ? query.data.model : undefined;
    try {
      return { success: true, data: await resolveImagePricingMatrix(billing, { model }) };
    } catch (error) {
      app.log.error(error);
      return reply.code(502).send({ error: "获取生图计价失败" });
    }
  });

  app.get("/api/workflow/images/tasks", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    let rows = await listRecentTasks(prisma, userId);
    if (await resumeTasksIfNeeded(rows)) rows = await listRecentTasks(prisma, userId);
    return { success: true, data: rows.map(serializeTask) };
  });

  app.get("/api/workflow/images/state", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
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

  app.post("/api/workflow/images/optimize-prompt", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
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
    if (cancelled.count === 1) {
      // 取消也走统一结算：已生成几张就结算几张，0 张才整单退款
      await settleImageTaskBilling({
        prisma,
        billing,
        taskId: task.id,
        reason: "cancelled",
        onBillingError: (error, operationId) => {
          app.log.warn({ requestId, operationId, error: safeErrorMessage(error) }, "image task cancellation settlement failed");
        },
      });
    }
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

    // 预留（而非直接扣费），任务终态时按实际产出结算；扣费行优先命中管理台配置的模型专属 key
    let chargeRow: WorkflowResourcePriceRow;
    try {
      const priceRows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
      chargeRow = resolveImageChargeRow(priceRows, { resolution: request.resolution, model: requestedModel });
      await billing.reserveResource({
        operationId: chargedOperationId,
        userId,
        resourceKey: chargeRow.resourceKey,
        units: request.count,
        // 预留一直持有到任务终态：count 张图 × 每张的全部重试远超 billing 的 10 分钟兜底，
        // 不声明就会在出图途中被按 actual=0 关账，之后结算静默返回 0。
        // 用闭包里的 maxAttempts（deps 可覆盖）而不是再读一次环境，避免注入了更大的重试
        // 预算时窗口反而按默认值算短。
        reservationTtlSeconds: imageReservationTtlSeconds({ count: request.count, maxAttempts }),
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
          sourceImageAssetId: request.sourceImageAssetId ?? null,
          generationIntent: request.generationIntent,
          count: request.count,
          status: IMAGE_TASK_STATUS.running,
          completedCount: existing.length,
          error: null,
          billingMode: "reserve",
          billingResourceKey: chargeRow.resourceKey,
          billingReservedUnits: request.count,
          billingStatus: "reserved",
        },
      });
    } catch (error) {
      // 并发重复提交：requestId 唯一键冲突说明另一次请求已建单，预留归赢家所有，绝不能退款
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
        maxAttempts,
        signal,
        onAttemptFailure: (error, attempt) => {
          app.log.warn({
            requestId: task.requestId,
            attempt,
            error: safeErrorMessage(error),
          }, "image generation attempt failed; retrying");
        },
        onBillingError: (error, operationId) => {
          app.log.error({ requestId: task.requestId, operationId, err: error }, "image task billing settlement failed");
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
