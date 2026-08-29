/**
 * 拆分 image-routes.ts 时抽出的无状态工具层：请求 schema、序列化、blob 签名、
 * S3 装载、提示词优化、以及 `activeGenerationTasks` 这一份取消登记表。
 *
 * `activeGenerationTasks` 必须只在本文件存在一份：task-runner 往里登记 AbortController、
 * 插件的 cancel 路由从里面取出来 abort，两边 import 的是同一个模块实例才对得上。
 * 谁再在自己文件里 new 一个 Map，取消就会静默失效（abort 到了另一张表上）。
 *
 * 本文件不 import billing / task-runner，方向是单向的：helpers ← billing ← task-runner ← routes。
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { deleteObject, loadS3Config, makeS3, type S3Config } from "../../storage/s3.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import { IMAGE_TASK_STATUS, type ImageGenerationTaskRow } from "./image-shared.js";
import {
  callImageGeneration as callImageGenerationService,
  IMAGE_GENERATION_MODELS,
  loadImageGenerationConfig,
  loadImageGenerationConfigForModel,
  QWEN_IMAGE_MODEL,
  type GeneratedImage,
  type ImageGenerationConfig,
} from "../_shared/image-service.js";
import type {
  ImageTaskStatus,
  OptimizedPromptResult,
  PromptOptimizationUsage,
  RetryOptions,
} from "./image-route-types.js";

export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "mimo-v2.5-pro-ultraspeed";
export const IMAGE_KEEP_LIMIT = 50;
export const IMAGE_TASK_KEEP_LIMIT = 12;
export const IMAGE_MAX_COUNT = 8;
export const DEFAULT_RETRY_DELAY_MS = 3000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const IMAGE_BLOB_URL_TTL_MS = 15 * 60_000;
export const ECOM_IMAGE_REQUEST_PREFIX = "ecom-";
export const IMAGE_GENERATION_INTENTS = ["new", "variation", "edit"] as const;
export const imageRequestSchema = z.object({
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

export const imageReferenceSchema = z.object({
  image: z.object({
    b64: z.string().trim().min(1),
    mime: z.string().trim().regex(/^image\/[A-Za-z0-9.+-]+$/).optional(),
  }),
});

export const imageBlobParamsSchema = z.object({
  imageId: z.string().trim().min(1).max(128),
});

export const imageBlobQuerySchema = z.object({
  exp: z.coerce.number().int().positive(),
  sig: z.string().trim().min(1).max(128),
});

export type ImageGenerationRequest = z.infer<typeof imageRequestSchema>;

export const optimizePromptSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

export const imageTaskParamsSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});

export const imagePricingQuerySchema = z.object({
  model: z.string().trim().min(1).max(128).optional(),
});
export class ImageTaskStoppedError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status === IMAGE_TASK_STATUS.cancelled ? "用户已取消" : "任务已结束");
    this.name = "ImageTaskStoppedError";
    this.status = status;
  }
}

export const activeGenerationTasks = new Map<string, AbortController>();

export function tryLoadImageGenerationConfig(model?: string): ImageGenerationConfig | null {
  try {
    return model ? loadImageGenerationConfigForModel(model) : loadImageGenerationConfig();
  } catch {
    return null;
  }
}
export function loadImageMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IMAGE_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? Math.min(10, value) : DEFAULT_MAX_ATTEMPTS;
}

export async function callImageGeneration(
  cfg: ImageGenerationConfig,
  prompt: string,
  size: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  return callImageGenerationService({ config: cfg, prompt, size, fetchFn, signal });
}

export async function retryUntilSuccess<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
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

export function tryLoadS3(env: NodeJS.ProcessEnv = process.env): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

export async function pruneImages(prisma: PrismaClient, userId: string): Promise<void> {
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

export async function listRecentImages(prisma: PrismaClient, userId: string) {
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

export function imageBlobSigningSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");
  return secret;
}

export function imageBlobSignaturePayload(imageId: string, objectKey: string, exp: number): string {
  return `${imageId}\n${objectKey}\n${exp}`;
}

export function imageBlobUrl(imageId: string, objectKey: string): string {
  const exp = Date.now() + IMAGE_BLOB_URL_TTL_MS;
  const sig = createHmac("sha256", imageBlobSigningSecret())
    .update(imageBlobSignaturePayload(imageId, objectKey, exp))
    .digest("base64url");
  const query = new URLSearchParams({ exp: String(exp), sig });
  return `/api/workflow/images/${encodeURIComponent(imageId)}/blob?${query.toString()}`;
}

export function hasValidImageBlobAccess(imageId: string, objectKey: string, exp: number, sig: string): boolean {
  if (exp < Date.now()) return false;
  const expected = createHmac("sha256", imageBlobSigningSecret())
    .update(imageBlobSignaturePayload(imageId, objectKey, exp))
    .digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function serializeImageRow<Row extends {
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

export function serializeTask(row: ImageGenerationTaskRow) {
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

export function completedTaskFromAssets(
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

export async function listRecentTasks(prisma: PrismaClient, userId: string): Promise<ImageGenerationTaskRow[]> {
  return prisma.imageGenerationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: IMAGE_TASK_KEEP_LIMIT,
  });
}

export function stripPromptFence(text: string): string {
  return text
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export function estimatePromptOptimizationInputTokens(prompt: string): number {
  return Math.max(1, Math.ceil((prompt.length + 120) / 3));
}

export function fallbackPromptOptimizationUsage(sourcePrompt: string, optimizedPrompt: string): PromptOptimizationUsage {
  return {
    inputTokens: estimatePromptOptimizationInputTokens(sourcePrompt),
    outputTokens: Math.max(1, Math.ceil(optimizedPrompt.length / 3)),
  };
}

export function resolvePromptOptimizerModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.IMAGE_PROMPT_OPTIMIZER_MODEL ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL).trim()
    || DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL;
}

export function normalizeOptimizedPromptResult(sourcePrompt: string, result: string | OptimizedPromptResult): OptimizedPromptResult {
  if (typeof result === "string") {
    return {
      prompt: result,
      model: resolvePromptOptimizerModel(),
      usage: fallbackPromptOptimizationUsage(sourcePrompt, result),
    };
  }
  return result;
}

export async function optimizeImagePrompt(prompt: string): Promise<OptimizedPromptResult> {
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

export async function updateTask(
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

export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "生成失败");
}

export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

export async function assertImageTaskRunning(prisma: PrismaClient, taskId: string): Promise<void> {
  const current = await prisma.imageGenerationTask.findUnique({ where: { id: taskId } });
  if (!current) throw new Error("image task not found");
  if (current.status !== IMAGE_TASK_STATUS.running) throw new ImageTaskStoppedError(current.status);
}
