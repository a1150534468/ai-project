import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { deleteObject, loadS3Config, makeS3, putObject, type S3Config } from "../storage/s3.js";
import { imageGenerationResourceKey, imageResolutionFromSize, normalizeImageSize, upstreamImageOptions } from "./image-upstream-options.js";
import { resolveImagePricing, type WorkflowResourcePriceRow } from "./workflow-pricing.js";

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "mimo-v2.5-pro-ultraspeed";
const IMAGE_KEEP_LIMIT = 50;
const IMAGE_TASK_KEEP_LIMIT = 12;
const IMAGE_MAX_COUNT = 8;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_STALE_TASK_MS = DEFAULT_ATTEMPT_TIMEOUT_MS + DEFAULT_RETRY_DELAY_MS + 30_000;
const DEFAULT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const ECOM_IMAGE_REQUEST_PREFIX = "ecom-";
const IMAGE_TASK_STATUS = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

const imageRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  prompt: z.string().trim().min(1).max(4000),
  size: z.string().trim().min(1).max(32).default("1024x1024"),
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  count: z.number().int().min(1).max(IMAGE_MAX_COUNT),
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
}

interface ImageGenerationConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
}

type GeneratedImage =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "b64"; readonly b64: string; readonly mime: string };

interface StoredImage {
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly mime: string;
  readonly objectKey: string | null;
}

interface ImageGenerationTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function imageEndpointFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.IMAGE_GENERATION_ENDPOINT?.trim();
  if (explicit) return explicit;
  const baseURL = (env.IMAGE_BASE_URL ?? env.LLM_BASE_URL ?? "").trim();
  if (!baseURL) throw new Error("IMAGE_BASE_URL/LLM_BASE_URL required");
  const base = trimTrailingSlash(baseURL);
  return base.endsWith("/v1") ? `${base}/images/generations` : `${base}/v1/images/generations`;
}

function loadImageGenerationConfig(env: NodeJS.ProcessEnv = process.env): ImageGenerationConfig {
  const apiKey = (env.IMAGE_API_KEY ?? env.LLM_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("IMAGE_API_KEY/LLM_API_KEY required");
  return {
    endpoint: imageEndpointFromEnv(env),
    apiKey,
    model: (env.IMAGE_GENERATION_MODEL ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
  };
}

function tryLoadImageGenerationConfig(): ImageGenerationConfig | null {
  try {
    return loadImageGenerationConfig();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractGeneratedImage(payload: unknown): GeneratedImage {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error("image response missing data");
  }
  const first = payload.data[0];
  if (!isRecord(first)) throw new Error("image response item invalid");
  if (typeof first.url === "string" && first.url.length > 0) {
    return { kind: "url", url: first.url };
  }
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const mime = typeof first.mime_type === "string" && first.mime_type.startsWith("image/") ? first.mime_type : "image/png";
    return { kind: "b64", b64: first.b64_json, mime };
  }
  throw new Error("image response has no url or b64_json");
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
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
  const upstreamOptions = upstreamImageOptions(size);
  if (upstreamOptions.size !== "auto") body.size = upstreamOptions.size;
  if (upstreamOptions.resolution) body.resolution = upstreamOptions.resolution;
  const response = await fetchWithTimeout(fetchFn, cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  }, loadImageAttemptTimeoutMs(), signal);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = `image relay ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`;
    throw new Error(message);
  }
  return extractGeneratedImage(await response.json());
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

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const configuredBase = (env.IMAGE_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encodedKey = encodeObjectKey(key);
  if (configuredBase) return `${trimTrailingSlash(configuredBase)}/${encodedKey}`;
  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) {
    return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  }
  return `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`;
}

function tryLoadS3(env: NodeJS.ProcessEnv = process.env): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

async function fetchRemoteImage(url: string, fetchFn: typeof fetch): Promise<{ readonly buffer: Buffer; readonly mime: string }> {
  const response = await fetchWithTimeout(fetchFn, url, { method: "GET" }, 60_000);
  if (!response.ok) throw new Error(`image download ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = Number(process.env.IMAGE_MAX_BYTES) || DEFAULT_IMAGE_MAX_BYTES;
  if (buffer.byteLength > maxBytes) throw new Error("image too large");
  const contentType = response.headers.get("content-type") ?? "image/png";
  return { buffer, mime: contentType.startsWith("image/") ? contentType : "image/png" };
}

async function storeGeneratedImage(
  image: GeneratedImage,
  userId: string,
  requestId: string,
  requestIndex: number,
  fetchFn: typeof fetch,
): Promise<StoredImage> {
  const loaded = tryLoadS3();
  if (image.kind === "url" && !loaded) {
    return { originalUrl: image.url, thumbnailUrl: image.url, mime: "image/png", objectKey: null };
  }

  const binary = image.kind === "b64"
    ? { buffer: Buffer.from(image.b64, "base64"), mime: image.mime }
    : await fetchRemoteImage(image.url, fetchFn);

  if (!loaded) {
    const dataUrl = `data:${binary.mime};base64,${binary.buffer.toString("base64")}`;
    return { originalUrl: dataUrl, thumbnailUrl: dataUrl, mime: binary.mime, objectKey: null };
  }

  const extension = binary.mime.includes("jpeg") || binary.mime.includes("jpg") ? "jpg" : "png";
  const key = `workflow/images/${userId}/${requestId}/${requestIndex}-${randomUUID()}.${extension}`;
  await putObject(loaded.s3, key, binary.buffer, binary.mime, { acl: "public-read" });
  const url = publicObjectUrl(loaded.cfg, key);
  return { originalUrl: url, thumbnailUrl: url, mime: binary.mime, objectKey: key };
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
      mime: true,
      createdAt: true,
    },
  });
}

function serializeImageRow<Row extends { readonly createdAt: Date }>(row: Row): Omit<Row, "createdAt"> & { readonly createdAt: string } {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function serializeTask(row: ImageGenerationTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    prompt: row.prompt,
    model: row.model,
    size: row.size,
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
  request: ImageGenerationRequest,
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
      content: `把下面的生图提示词优化成适合 gpt-image-2 的高质量商业图片提示词。保留用户主体，不增加违背原意的元素，补充构图、光线、材质、风格和画面质量要求。\n\n原始提示词：${prompt}`,
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
    let completedCount = existing.length;
    await updateTask(prisma, task.id, { status: IMAGE_TASK_STATUS.running, completedCount, error: null });

    await Promise.all(missingIndexes.map(async (requestIndex) => {
      const stored = await retryUntilSuccess(async () => {
        await assertImageTaskRunning(prisma, task.id);
        const generated = await callImageGeneration(cfg, task.prompt, task.size, fetchFn, args.signal);
        await assertImageTaskRunning(prisma, task.id);
        const storedImage = await storeGeneratedImage(generated, task.userId, task.requestId, requestIndex, fetchFn);
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
  readonly cfg: ImageGenerationConfig | null;
  readonly tasks: readonly ImageGenerationTaskRow[];
  readonly scheduleTask: ScheduleTask;
  readonly retryDelayMs: number;
  readonly maxAttempts?: number;
  readonly staleTaskMs: number;
  readonly onResume: (task: ImageGenerationTaskRow) => void;
  readonly onAttemptFailure: (task: ImageGenerationTaskRow, error: unknown, attempt: number) => void;
}): Promise<number> {
  const cfg = args.cfg;
  if (!cfg) return 0;
  const staleTasks = args.tasks.filter((task) =>
    !activeGenerationTasks.has(task.requestId) && isStaleRunningTask(task, args.staleTaskMs)
  );
  const resumed = await Promise.all(staleTasks.map(async (task) => {
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
      cfg: tryLoadImageGenerationConfig(),
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

  app.get("/api/workflow/images", async (req, reply) => {
    const userId = (req as unknown as { userId: string }).userId;
    if (!userId) return reply.code(401).send({ error: "未登录" });
    const rows = await listRecentImages(prisma, userId);
    return { success: true, data: rows.map(serializeImageRow) };
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

    const cfg = loadImageGenerationConfig();
    const normalizedSize = normalizeImageSize(parsed.data.size);
    const request = { ...parsed.data, size: normalizedSize, resolution: imageResolutionFromSize(normalizedSize, parsed.data.resolution) };
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
