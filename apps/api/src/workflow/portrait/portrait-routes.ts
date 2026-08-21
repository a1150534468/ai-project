import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Metadata } from "sharp";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/require-user.js";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { deleteObject, getObject, loadS3Config, makeS3 } from "../storage/s3.js";
import {
  callImageEdit as callImageEditService,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  isRetryableImageGenerationError,
  loadImageGenerationConfigForModel,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageBinaryInput,
  type ImageGenerationConfig,
  type StoredImage,
} from "./image-service.js";
import {
  buildPortraitPrompt,
  LEGACY_PORTRAIT_PRESET_NAMES,
  PORTRAIT_CONSENT_VERSION,
  PORTRAIT_MODEL,
  PORTRAIT_MODELS,
  PORTRAIT_PRESET_IDS,
  PORTRAIT_PRESETS,
  portraitOutputSize,
  type PortraitAspectRatio,
  type PortraitModelValue,
  type PortraitPresetId,
  type PortraitPromptOptions,
  type PortraitResolution,
} from "./portrait-prompts.js";
import {
  resolveImageChargeRow,
  type WorkflowResourcePriceRow,
} from "./workflow-pricing.js";
import { deliveredImageResolution, minDeliveredPixels, pixelsFromSize } from "./image-delivered-tier.js";
import type { ImageResolutionLabel } from "./image-upstream-options.js";
import { startPortraitReaper } from "./portrait-reaper.js";
import { loadSharp } from "../runtime/resource-limits.js";
import {
  PORTRAIT_ACTIVE_STATUSES,
  PORTRAIT_TERMINAL_STATUSES,
  portraitMaxAttempts,
  portraitRetryDelayMs,
} from "./portrait-shared.js";

const PORTRAIT_MAX_REFERENCE_COUNT = 3;
const PORTRAIT_MAX_COUNT = 4;
const PORTRAIT_REFERENCE_MAX_PIXELS = 40_000_000;
const PORTRAIT_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const PORTRAIT_BLOB_TTL_MS = 15 * 60 * 1000;
const PORTRAIT_TASK_KEEP_LIMIT = 30;

const portraitReferenceMimeTypes = new Set([...IMAGE_REFERENCE_MIME_TYPES, "image/heic", "image/heif"]);
const portraitReferenceSchema = z.object({
  image: z.object({
    b64: z.string().trim().min(1),
    mime: z.string().trim().regex(/^image\/[A-Za-z0-9.+-]+$/).optional(),
  }),
});
const PORTRAIT_MODEL_VALUES = PORTRAIT_MODELS.map((item) => item.value) as [PortraitModelValue, ...PortraitModelValue[]];
const portraitRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  presetId: z.enum(PORTRAIT_PRESET_IDS),
  model: z.enum(PORTRAIT_MODEL_VALUES).default(PORTRAIT_MODEL),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]),
  resolution: z.enum(["1K", "2K", "4K"]).default("2K"),
  count: z.number().int().min(1).max(PORTRAIT_MAX_COUNT).default(1),
  referenceAssetIds: z.array(z.string().trim().min(1).max(128)).min(1).max(PORTRAIT_MAX_REFERENCE_COUNT)
    .refine((ids) => new Set(ids).size === ids.length, "参考图不能重复"),
  options: z.object({
    scene: z.string().trim().max(200).optional().default(""),
    outfit: z.string().trim().max(200).optional().default(""),
    composition: z.string().trim().max(200).optional().default(""),
    expression: z.string().trim().max(200).optional().default(""),
    hair: z.string().trim().max(200).optional().default(""),
    makeup: z.string().trim().max(200).optional().default(""),
    extraPrompt: z.string().trim().max(1200).optional().default(""),
  }).default({}),
  authorizationAccepted: z.literal(true),
  consentVersion: z.literal(PORTRAIT_CONSENT_VERSION),
});
const blobParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const blobQuerySchema = z.object({ exp: z.coerce.number().int().positive(), sig: z.string().trim().min(1).max(128) });

type PortraitTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";
type PortraitTaskRow = {
  id: string;
  userId: string;
  requestId: string;
  model: string;
  presetId: string;
  aspectRatio: string;
  resolution: string;
  count: number;
  prompt: string;
  effectivePrompt: string;
  options: unknown;
  referenceAssetIds: string[];
  status: PortraitTaskStatus;
  completedCount: number;
  error: string | null;
  consentVersion: string;
  billingOperationId: string;
  billingResourceKey: string;
  billingReservedUnits: number;
  billingSettledUnits: number;
  billingStatus: string;
  cancelRequested: boolean;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  outputs?: PortraitOutputRow[];
};
type PortraitOutputRow = {
  id: string;
  taskId: string;
  userId: string;
  requestIndex: number;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: Date;
};
type PortraitReferenceRow = {
  id: string;
  userId: string;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

interface PortraitBilling {
  reserveResource: (args: { operationId: string; userId: string; resourceKey: string; units: number }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

interface PortraitRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: PortraitBilling;
  /** 传了才起主动扫兜底；不传（单测）只保留 GET /state 的被动 recover。 */
  readonly redis?: Redis;
  readonly fetchFn?: typeof fetch;
  readonly scheduleTask?: (work: () => Promise<void>) => void;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly storeImage?: (args: {
    image: GeneratedImage;
    userId: string;
    requestId: string;
    requestIndex: number;
    fetchFn: typeof fetch;
    env?: NodeJS.ProcessEnv;
    namespace: string;
    acl: "private";
  }) => Promise<StoredImage>;
  readonly loadStoredImage?: (objectKey: string) => Promise<Buffer>;
  readonly deleteStoredImage?: (objectKey: string) => Promise<void>;
  readonly callImageEdit?: (args: {
    config: ImageGenerationConfig;
    prompt: string;
    referenceImages: readonly ImageBinaryInput[];
    fetchFn: typeof fetch;
    size: string;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }) => Promise<GeneratedImage>;
}

function nowPlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof InsufficientBalanceError) return "余额不足，请充值";
  if (error instanceof Error) return error.message.slice(0, 300);
  return "人像生成失败";
}

function portraitBlobSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.PORTRAIT_BLOB_SIGNING_SECRET?.trim() || env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) throw new Error("portrait blob signing secret is not configured");
  return secret;
}

function portraitBlobSignature(kind: "reference" | "output", id: string, objectKey: string, exp: number, env?: NodeJS.ProcessEnv): string {
  return createHmac("sha256", portraitBlobSecret(env)).update(`${kind}:${id}:${objectKey}:${exp}`).digest("hex");
}

function portraitBlobUrl(kind: "reference" | "output", id: string, objectKey: string, env?: NodeJS.ProcessEnv): string {
  const exp = Math.floor((Date.now() + PORTRAIT_BLOB_TTL_MS) / 1000);
  const sig = portraitBlobSignature(kind, id, objectKey, exp, env);
  const path = kind === "reference" ? "references" : "outputs";
  return `/api/workflow/portraits/${path}/${encodeURIComponent(id)}/blob?exp=${exp}&sig=${sig}`;
}

function hasValidBlobSignature(kind: "reference" | "output", id: string, objectKey: string, exp: number, sig: string, env?: NodeJS.ProcessEnv): boolean {
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = portraitBlobSignature(kind, id, objectKey, exp, env);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPortraitObjectKeyForUser(value: string, userId: string, kind: "references" | "outputs"): boolean {
  if (!value.startsWith(`workflow/portraits/${kind}/`) || value.includes("\\") || value.includes("..")) return false;
  const segments = value.split("/");
  return segments.length >= 5 && segments[3] === userId && segments.every((segment) => segment.length > 0 && segment !== ".");
}

function serializeReference(row: PortraitReferenceRow, env?: NodeJS.ProcessEnv) {
  return {
    id: row.id,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    previewUrl: portraitBlobUrl("reference", row.id, row.objectKey, env),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeOutput(row: PortraitOutputRow, env?: NodeJS.ProcessEnv) {
  return {
    id: row.id,
    index: row.requestIndex,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    originalUrl: portraitBlobUrl("output", row.id, row.objectKey, env),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeTask(row: PortraitTaskRow, env?: NodeJS.ProcessEnv) {
  return {
    id: row.id,
    requestId: row.requestId,
    model: row.model,
    presetId: row.presetId,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    count: row.count,
    prompt: row.prompt,
    referenceAssetIds: row.referenceAssetIds,
    status: row.status,
    completedCount: row.completedCount,
    error: row.error,
    billingStatus: row.billingStatus,
    outputs: (row.outputs ?? []).sort((a, b) => a.requestIndex - b.requestIndex).map((output) => serializeOutput(output, env)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function listTaskWithOutputs(prisma: PrismaClient, userId: string, requestId?: string): Promise<PortraitTaskRow | null> {
  return prisma.portraitTask.findFirst({
    where: { userId, ...(requestId ? { requestId } : {}) },
    include: { outputs: { orderBy: { requestIndex: "asc" } } },
    orderBy: { createdAt: "desc" },
  }) as unknown as Promise<PortraitTaskRow | null>;
}

async function loadOwnedReferences(prisma: PrismaClient, userId: string, ids: readonly string[]): Promise<PortraitReferenceRow[]> {
  const rows = await prisma.portraitReferenceAsset.findMany({ where: { userId, id: { in: [...ids] }, deletedAt: null } }) as unknown as PortraitReferenceRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== ids.length || ids.some((id) => !byId.has(id))) throw new Error("参考图不存在或无权访问");
  return ids.map((id) => byId.get(id)!);
}

async function cleanupExpiredPortraitReferences(args: {
  readonly prisma: PrismaClient;
  readonly deleteStoredImage: (objectKey: string) => Promise<void>;
  readonly now?: Date;
}): Promise<number> {
  const rows = await args.prisma.portraitReferenceAsset.findMany({
    where: { deletedAt: null, expiresAt: { lte: args.now ?? new Date() } },
    take: 100,
  }) as unknown as PortraitReferenceRow[];
  let removed = 0;
  for (const row of rows) {
    const active = await args.prisma.portraitTask.findFirst({
      where: { status: { in: ["pending", "running"] }, referenceAssetIds: { has: row.id } },
      select: { id: true },
    });
    if (active) continue;
    await args.deleteStoredImage(row.objectKey).catch(() => undefined);
    await args.prisma.portraitReferenceAsset.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    removed += 1;
  }
  return removed;
}

async function markReferencesForCleanup(prisma: PrismaClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.portraitReferenceAsset.updateMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    data: { expiresAt: nowPlus(PORTRAIT_REFERENCE_TTL_MS) },
  });
}

function normalizePortraitResolution(value: string): ImageResolutionLabel {
  const normalized = value.trim().toUpperCase();
  return normalized === "1K" || normalized === "2K" || normalized === "4K" ? normalized : "2K";
}

/**
 * 结算用的 resourceKey：按实际交付像素反查档位，而不是照用户请求的档位收钱。
 * 上游会忽略我们请求的绝对像素、只按宽高比给固定预算（实测请求 2K 也只交付 ~1.57MP），
 * 照请求档位结算等于让用户为 1K 的像素付 2K 的价。结算档位永不高于请求档位。
 * 任何一步算不出来都回落到预留时那个 key，宁可保持原样也不要把结算搞挂。
 */
async function resolvePortraitSettleKey(args: {
  readonly prisma: PrismaClient;
  readonly billing: PortraitBilling;
  readonly task: PortraitTaskRow;
}): Promise<{ readonly resourceKey: string; readonly settledResolution: string }> {
  const fallback = { resourceKey: args.task.billingResourceKey, settledResolution: args.task.resolution };
  try {
    const outputs = await args.prisma.portraitOutput.findMany({
      where: { taskId: args.task.id },
      select: { width: true, height: true },
    });
    const deliveredPixels = minDeliveredPixels(outputs.map((output) => `${output.width}x${output.height}`));
    const requested = normalizePortraitResolution(args.task.resolution);
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels,
      pixelsForResolution: (resolution) => pixelsFromSize(
        portraitOutputSize(resolution as PortraitResolution, args.task.aspectRatio as PortraitAspectRatio),
      ),
    });
    if (settled === requested) return fallback;
    const rows = args.billing.listResourcePrices ? (await args.billing.listResourcePrices()).data ?? [] : [];
    const row = resolveImageChargeRow(rows, { resolution: settled, model: args.task.model });
    return { resourceKey: row.resourceKey, settledResolution: settled };
  } catch {
    return fallback;
  }
}

async function settlePortraitBilling(args: {
  readonly prisma: PrismaClient;
  readonly billing: PortraitBilling;
  readonly task: PortraitTaskRow;
  readonly units: number;
}): Promise<void> {
  const current = await args.prisma.portraitTask.findUnique({ where: { id: args.task.id } }) as unknown as PortraitTaskRow | null;
  if (!current || current.billingStatus === "settled" || current.billingStatus === "refunded") return;
  if (args.units > 0) {
    const settle = await resolvePortraitSettleKey({ prisma: args.prisma, billing: args.billing, task: current });
    await args.billing.settleResource({ operationId: current.billingOperationId, resourceKey: settle.resourceKey, units: args.units });
    // 落库成真正扣掉的那个 key；预留时那个 key 仍在计费服务的 UsageRecord 里，对账两头都查得到。
    await args.prisma.portraitTask.update({
      where: { id: current.id },
      data: { billingStatus: "settled", billingSettledUnits: args.units, billingResourceKey: settle.resourceKey },
    });
  } else {
    await args.billing.refundResource(current.billingOperationId);
    await args.prisma.portraitTask.update({ where: { id: current.id }, data: { billingStatus: "refunded", billingSettledUnits: 0 } });
  }
}

async function retryPortrait<T>(fn: () => Promise<T>, maxAttempts: number, retryDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableImageGenerationError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError;
}

async function runPortraitTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: PortraitBilling;
  readonly fetchFn: typeof fetch;
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly storeImage: NonNullable<PortraitRouteDeps["storeImage"]>;
  readonly loadStoredImage: (objectKey: string) => Promise<Buffer>;
  readonly callImageEdit: NonNullable<PortraitRouteDeps["callImageEdit"]>;
  readonly onFailure?: (taskId: string, error: unknown) => void;
}): Promise<void> {
  const sharp = await loadSharp();
  const task = await args.prisma.portraitTask.findUnique({ where: { id: args.taskId }, include: { outputs: true } }) as unknown as PortraitTaskRow | null;
  if (!task) return;
  const existing = (task.outputs ?? []).slice().sort((a, b) => a.requestIndex - b.requestIndex);
  let completedCount = existing.length;
  try {
    const references = await loadOwnedReferences(args.prisma, task.userId, task.referenceAssetIds);
    if (references.some((reference) => !isPortraitObjectKeyForUser(reference.objectKey, task.userId, "references"))) {
      throw new Error("参考图存储位置不合法");
    }
    const referenceImages = await Promise.all(references.map(async (reference, index) => ({
      b64: (await args.loadStoredImage(reference.objectKey)).toString("base64"),
      mime: reference.mime,
      filename: `portrait-reference-${index + 1}.jpg`,
    })));
    const config = loadImageGenerationConfigForModel(task.model);
    await args.prisma.portraitTask.update({ where: { id: task.id }, data: { status: "running", error: null } });
    for (let requestIndex = 0; requestIndex < task.count; requestIndex += 1) {
      if (existing.some((output) => output.requestIndex === requestIndex)) continue;
      const current = await args.prisma.portraitTask.findUnique({ where: { id: task.id } }) as unknown as PortraitTaskRow | null;
      if (!current || current.cancelRequested || current.status === "cancelled" || args.signal.aborted) throw new Error("__PORTRAIT_CANCELLED__");
      const generated = await retryPortrait(() => args.callImageEdit({
        config,
        prompt: task.effectivePrompt,
        referenceImages,
        fetchFn: args.fetchFn,
        size: portraitOutputSize(task.resolution as PortraitResolution, task.aspectRatio as PortraitAspectRatio),
        signal: args.signal,
      }), args.maxAttempts, args.retryDelayMs);
      const stored = await args.storeImage({
        image: generated,
        userId: task.userId,
        requestId: task.requestId,
        requestIndex,
        fetchFn: args.fetchFn,
        namespace: "workflow/portraits/outputs",
        acl: "private",
      });
      if (!stored.objectKey || !isPortraitObjectKeyForUser(stored.objectKey, task.userId, "outputs")) {
        throw new Error("人像结果存储位置不合法");
      }
      const outputBuffer = await args.loadStoredImage(stored.objectKey);
      const metadata = await sharp(outputBuffer, { limitInputPixels: 40_000_000 }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("生成结果不是有效图片");
      await args.prisma.portraitOutput.upsert({
        where: { taskId_requestIndex: { taskId: task.id, requestIndex } },
        update: {},
        create: {
          taskId: task.id,
          userId: task.userId,
          requestIndex,
          objectKey: stored.objectKey,
          mime: stored.mime.startsWith("image/") ? stored.mime : "image/png",
          width: metadata.width,
          height: metadata.height,
          sizeBytes: outputBuffer.byteLength,
        },
      });
      completedCount += 1;
      await args.prisma.portraitTask.update({ where: { id: task.id }, data: { completedCount, error: null } });
    }
    await settlePortraitBilling({ prisma: args.prisma, billing: args.billing, task, units: completedCount });
    await args.prisma.portraitTask.update({ where: { id: task.id }, data: { status: "completed", completedCount, completedAt: new Date(), error: null } });
    await markReferencesForCleanup(args.prisma, task.referenceAssetIds);
  } catch (error) {
    const latest = await args.prisma.portraitTask.findUnique({ where: { id: task.id } }) as unknown as PortraitTaskRow | null;
    const cancelled = args.signal.aborted
      || latest?.cancelRequested === true
      || latest?.status === "cancelled"
      || (error instanceof Error && error.message === "__PORTRAIT_CANCELLED__");
    const status: PortraitTaskStatus = cancelled ? "cancelled" : completedCount > 0 ? "partial" : "failed";
    await settlePortraitBilling({ prisma: args.prisma, billing: args.billing, task, units: completedCount }).catch(() => undefined);
    await args.prisma.portraitTask.update({
      where: { id: task.id },
      data: { status, completedCount, completedAt: new Date(), error: cancelled ? "用户已取消" : safeErrorMessage(error) },
    }).catch(() => undefined);
    await markReferencesForCleanup(args.prisma, task.referenceAssetIds).catch(() => undefined);
    if (!cancelled) args.onFailure?.(task.id, error);
  }
}

export async function portraitWorkflowRoutes(app: FastifyInstance, deps: PortraitRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
  const fetchFn = deps.fetchFn ?? fetch;
  const storeImage = deps.storeImage ?? storeWorkflowImageService;
  const loadStoredImage = deps.loadStoredImage ?? ((objectKey: string) => getObject(makeS3(loadS3Config()), objectKey));
  const deleteStoredImage = deps.deleteStoredImage ?? ((objectKey: string) => deleteObject(makeS3(loadS3Config()), objectKey));
  const callImageEdit = deps.callImageEdit ?? (async (args: Parameters<typeof callImageEditService>[0]) => callImageEditService(args));
  const scheduleTask = deps.scheduleTask ?? ((work: () => Promise<void>) => { void work().catch(() => undefined); });
  const retryDelayMs = deps.retryDelayMs ?? portraitRetryDelayMs();
  const maxAttempts = deps.maxAttempts ?? portraitMaxAttempts();
  const activeTasks = new Map<string, AbortController>();
  // 管理台费率只拉一次；失败时回落通用 key 但必须留痕。
  const listPriceRows = async (): Promise<readonly WorkflowResourcePriceRow[]> => {
    if (!billing.listResourcePrices) return [];
    try {
      return (await billing.listResourcePrices()).data ?? [];
    } catch (error) {
      app.log.warn({ error: safeErrorMessage(error) }, "portrait listResourcePrices failed, falling back to generic image pricing keys");
      return [];
    }
  };

  const schedule = (task: PortraitTaskRow) => {
    if (activeTasks.has(task.requestId) || PORTRAIT_TERMINAL_STATUSES.has(task.status)) return;
    const controller = new AbortController();
    activeTasks.set(task.requestId, controller);
    scheduleTask(async () => {
      try {
        await runPortraitTask({ prisma, billing, fetchFn, taskId: task.id, signal: controller.signal, retryDelayMs, maxAttempts, storeImage, loadStoredImage, callImageEdit, onFailure: (taskId, error) => app.log.warn({ taskId, error: safeErrorMessage(error) }, "portrait generation failed") });
      } finally {
        if (activeTasks.get(task.requestId) === controller) activeTasks.delete(task.requestId);
      }
    });
  };

  /**
   * 续跑仍活着的任务：pending 重新预留后排期，running 直接排期。
   * 两个入口共用它——GET /state 的被动触发（按 userId 限定），
   * 和 reaper 的主动扫（跨用户，只捞心跳超期的行）。
   */
  const recover = async (opts: { userId?: string; rows?: readonly PortraitTaskRow[] } = {}) => {
    const rows = opts.rows ?? (await prisma.portraitTask.findMany({
      where: { ...(opts.userId ? { userId: opts.userId } : {}), status: { in: [...PORTRAIT_ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }) as unknown as PortraitTaskRow[]);
    for (const row of rows) {
      if (row.status === "pending") {
        try {
          await billing.reserveResource({ operationId: row.billingOperationId, userId: row.userId, resourceKey: row.billingResourceKey, units: row.count });
          const reserved = await prisma.portraitTask.update({
            where: { id: row.id },
            data: { status: "running", billingReservedUnits: row.count, billingStatus: "reserved", error: null },
          }) as unknown as PortraitTaskRow;
          schedule(reserved);
        } catch (error) {
          await prisma.portraitTask.update({
            where: { id: row.id },
            data: { status: "failed", billingStatus: "reserve_failed", completedAt: new Date(), error: safeErrorMessage(error) },
          }).catch(() => undefined);
          await markReferencesForCleanup(prisma, row.referenceAssetIds).catch(() => undefined);
        }
      } else {
        schedule(row);
      }
    }
    return rows.length;
  };

  const cleanupTimer = setInterval(() => {
    void cleanupExpiredPortraitReferences({ prisma, deleteStoredImage }).catch(() => undefined);
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  void cleanupExpiredPortraitReferences({ prisma, deleteStoredImage }).catch(() => undefined);

  /**
   * 主动扫兜底。原先续跑只挂在 GET /api/workflow/portraits/state 上：
   * 用户不回来刷页面，进程重启前排期的任务就永远停在 running，钱挂在预留里。
   * reaper 起在这里而不是 server.ts，是因为续跑要用到上面那套闭包依赖
   * （activeTasks / scheduleTask / callImageEdit …），搬到 server.ts 就得整套重接一遍。
   */
  const reaperTimer = deps.redis
    ? startPortraitReaper({
      prisma,
      redis: deps.redis,
      resume: async (row) => { await recover({ rows: [row as unknown as PortraitTaskRow] }); },
      settle: ({ task, units }) => settlePortraitBilling({
        prisma,
        billing,
        task: task as unknown as PortraitTaskRow,
        units,
      }),
      onError: (error) => app.log.warn({ error: safeErrorMessage(error) }, "portrait reaper tick failed"),
    })
    : undefined;

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    if (reaperTimer) clearInterval(reaperTimer);
    for (const controller of activeTasks.values()) controller.abort();
    activeTasks.clear();
  });

  app.get("/api/workflow/portraits/options", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const priceRows = await listPriceRows();
    const resolutions: readonly PortraitResolution[] = ["1K", "2K", "4K"];
    const pricingByModel: Record<string, Partial<Record<PortraitResolution, number>>> = {};
    for (const model of PORTRAIT_MODELS) {
      // 模型不支持的档位（gpt-image-2 无 4K、豆包无 1K）不下发价格，避免前端展示无法下单的档位。
      pricingByModel[model.value] = Object.fromEntries(resolutions
        .filter((resolution) => (resolution === "4K" ? model.supports4K : resolution === "1K" ? model.supports1K : true))
        .map((resolution) => [resolution, resolveImageChargeRow(priceRows, { resolution, model: model.value }).rate]));
    }
    return {
      success: true,
      data: {
        model: PORTRAIT_MODEL,
        models: PORTRAIT_MODELS,
        consentVersion: PORTRAIT_CONSENT_VERSION,
        presets: PORTRAIT_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description, finish: preset.finish })),
        legacyPresetNames: LEGACY_PORTRAIT_PRESET_NAMES,
        aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
        resolutions,
        pricing: Object.fromEntries(resolutions.map((resolution) => [resolution, resolveImageChargeRow(priceRows, { resolution })])),
        pricingByModel,
      },
    };
  });

  app.get("/api/workflow/portraits/references/:id/blob", async (req, reply) => {
    const params = blobParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = await prisma.portraitReferenceAsset.findUnique({ where: { id: params.data.id } }) as unknown as PortraitReferenceRow | null;
    if (!row || row.deletedAt || !isPortraitObjectKeyForUser(row.objectKey, row.userId, "references") || !hasValidBlobSignature("reference", row.id, row.objectKey, query.data.exp, query.data.sig)) return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      const buffer = await loadStoredImage(row.objectKey);
      return reply.header("Cache-Control", "private, max-age=300").type(row.mime).send(buffer);
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.get("/api/workflow/portraits/outputs/:id/blob", async (req, reply) => {
    const params = blobParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = await prisma.portraitOutput.findUnique({ where: { id: params.data.id } }) as unknown as PortraitOutputRow | null;
    if (!row || !isPortraitObjectKeyForUser(row.objectKey, row.userId, "outputs") || !hasValidBlobSignature("output", row.id, row.objectKey, query.data.exp, query.data.sig)) return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      const buffer = await loadStoredImage(row.objectKey);
      return reply.header("Cache-Control", "private, max-age=300").type(row.mime).header("Content-Disposition", `inline; filename="portrait-${row.requestIndex + 1}.png"`).send(buffer);
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.post("/api/workflow/portraits/references", { preHandler: requireUser }, async (req, reply) => {
    const sharp = await loadSharp();
    const userId = req.userId;
    const parsed = portraitReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参考图参数不合法" });
    const sourceBytes = Buffer.from(parsed.data.image.b64, "base64");
    if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > IMAGE_REFERENCE_MAX_BYTES) return reply.code(400).send({ error: "参考图大小需在 10MB 以内" });
    const sourceMime = (parsed.data.image.mime?.split(";", 1)[0]?.trim().toLowerCase() || "image/jpeg");
    if (!portraitReferenceMimeTypes.has(sourceMime)) return reply.code(400).send({ error: "参考图仅支持 JPG、PNG、WEBP、BMP、TIFF、GIF 或 HEIC" });
    let normalized: Buffer;
    let metadata: Metadata;
    try {
      metadata = await sharp(sourceBytes, { limitInputPixels: PORTRAIT_REFERENCE_MAX_PIXELS, animated: false }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > PORTRAIT_REFERENCE_MAX_PIXELS) throw new Error("invalid dimensions");
      normalized = await sharp(sourceBytes, { limitInputPixels: PORTRAIT_REFERENCE_MAX_PIXELS, animated: false })
        .rotate()
        .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
        .toBuffer();
    } catch {
      return reply.code(400).send({ error: "参考图不是可读取的图片，或像素尺寸过大" });
    }
    if (normalized.byteLength > IMAGE_REFERENCE_MAX_BYTES) return reply.code(400).send({ error: "参考图处理后超过 10MB" });
    const normalizedMetadata = await sharp(normalized).metadata();
    const requestId = `portrait-reference-${randomUUID()}`;
    let stored: StoredImage;
    try {
      stored = await storeImage({ image: { kind: "b64", b64: normalized.toString("base64"), mime: "image/jpeg" }, userId, requestId, requestIndex: 0, fetchFn, namespace: "workflow/portraits/references", acl: "private" });
    } catch {
      return reply.code(502).send({ error: "参考图存储失败" });
    }
    if (!stored.objectKey || !isPortraitObjectKeyForUser(stored.objectKey, userId, "references")) return reply.code(502).send({ error: "参考图存储位置不合法" });
    const row = await prisma.portraitReferenceAsset.create({
      data: {
        userId,
        objectKey: stored.objectKey,
        mime: "image/jpeg",
        width: normalizedMetadata.width ?? metadata.width!,
        height: normalizedMetadata.height ?? metadata.height!,
        sizeBytes: normalized.byteLength,
        expiresAt: nowPlus(PORTRAIT_REFERENCE_TTL_MS),
      },
    }) as unknown as PortraitReferenceRow;
    return { success: true, data: { asset: serializeReference(row) } };
  });

  app.delete("/api/workflow/portraits/references/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = blobParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "参考图参数不合法" });
    const row = await prisma.portraitReferenceAsset.findFirst({ where: { id: params.data.id, userId, deletedAt: null } }) as unknown as PortraitReferenceRow | null;
    if (!row) return reply.code(404).send({ error: "参考图不存在" });
    const active = await prisma.portraitTask.findFirst({ where: { userId, status: { in: ["pending", "running"] }, referenceAssetIds: { has: row.id } }, select: { id: true } });
    if (active) return reply.code(409).send({ error: "任务生成中，暂不能删除参考图" });
    await deleteStoredImage(row.objectKey).catch(() => undefined);
    await prisma.portraitReferenceAsset.update({ where: { id: row.id }, data: { deletedAt: new Date(), expiresAt: null } });
    return { success: true };
  });

  app.get("/api/workflow/portraits/state", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    await recover({ userId });
    const [references, tasks] = await Promise.all([
      prisma.portraitReferenceAsset.findMany({ where: { userId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: PORTRAIT_MAX_REFERENCE_COUNT }),
      prisma.portraitTask.findMany({ where: { userId }, include: { outputs: { orderBy: { requestIndex: "asc" } } }, orderBy: { createdAt: "desc" }, take: PORTRAIT_TASK_KEEP_LIMIT }),
    ]);
    return {
      success: true,
      data: {
        references: (references as unknown as PortraitReferenceRow[]).map((row) => serializeReference(row)),
        tasks: (tasks as unknown as PortraitTaskRow[]).map((row) => serializeTask(row)),
      },
    };
  });

  app.post("/api/workflow/portraits/generate", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const parsed = portraitRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "人像生成参数不完整，且必须确认你拥有参考人物的授权" });
    const model = PORTRAIT_MODELS.find((item) => item.value === parsed.data.model) ?? PORTRAIT_MODELS[0];
    if (parsed.data.resolution === "4K" && !model.supports4K) return reply.code(400).send({ error: `${model.label} 暂不支持 4K，请选择 2K` });
    if (parsed.data.resolution === "1K" && !model.supports1K) return reply.code(400).send({ error: `${model.label} 暂不支持 1K，请选择 2K` });
    const existing = await listTaskWithOutputs(prisma, userId, parsed.data.requestId);
    if (existing) return reply.code(existing.status === "completed" || existing.status === "partial" ? 200 : 202).send({ success: true, data: { task: serializeTask(existing) } });
    const crossUser = await prisma.portraitTask.findUnique({ where: { requestId: parsed.data.requestId }, select: { id: true } });
    if (crossUser) return reply.code(409).send({ error: "请求编号已被使用" });
    const references = await loadOwnedReferences(prisma, userId, parsed.data.referenceAssetIds).catch(() => null);
    if (!references) return reply.code(404).send({ error: "参考图不存在或无权访问" });
    const effectivePrompt = buildPortraitPrompt({ presetId: parsed.data.presetId as PortraitPresetId, aspectRatio: parsed.data.aspectRatio as PortraitAspectRatio, options: parsed.data.options as PortraitPromptOptions });
    // 管理台可为「模型专属/通用分辨率」key 配价，实际扣费必须使用命中的 resourceKey。
    const chargeRow = resolveImageChargeRow(await listPriceRows(), { resolution: parsed.data.resolution, model: model.value });
    const resourceKey = chargeRow.resourceKey;
    const billingOperationId = `portrait:${parsed.data.requestId}`;
    let task: PortraitTaskRow | null = null;
    let reserved = false;
    try {
      task = await prisma.portraitTask.create({
        data: {
          userId,
          requestId: parsed.data.requestId,
          model: model.value,
          presetId: parsed.data.presetId,
          aspectRatio: parsed.data.aspectRatio,
          resolution: parsed.data.resolution,
          count: parsed.data.count,
          prompt: parsed.data.options.extraPrompt ?? "",
          effectivePrompt,
          options: parsed.data.options,
          referenceAssetIds: parsed.data.referenceAssetIds,
          status: "pending",
          consentVersion: parsed.data.consentVersion,
          billingOperationId,
          billingResourceKey: resourceKey,
          billingReservedUnits: 0,
          billingSettledUnits: 0,
          billingStatus: "pending",
        },
        include: { outputs: true },
      }) as unknown as PortraitTaskRow;
      await billing.reserveResource({ operationId: billingOperationId, userId, resourceKey, units: parsed.data.count });
      reserved = true;
      task = await prisma.portraitTask.update({ where: { id: task.id }, data: { status: "running", billingReservedUnits: parsed.data.count, billingStatus: "reserved" }, include: { outputs: true } }) as unknown as PortraitTaskRow;
    } catch (error) {
      if (reserved) await billing.refundResource(billingOperationId).catch(() => undefined);
      if (task?.id) await prisma.portraitTask.delete({ where: { id: task.id } }).catch(() => undefined);
      const duplicate = await listTaskWithOutputs(prisma, userId, parsed.data.requestId).catch(() => null);
      if (duplicate) return reply.code(202).send({ success: true, data: { task: serializeTask(duplicate) } });
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "余额不足，请充值" });
      return reply.code(502).send({ error: "人像任务创建失败" });
    }
    schedule(task);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
  });

  app.post("/api/workflow/portraits/tasks/:requestId/cancel", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = z.object({ requestId: z.string().trim().min(8).max(128) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await listTaskWithOutputs(prisma, userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (PORTRAIT_TERMINAL_STATUSES.has(task.status)) return { success: true, data: { task: serializeTask(task) } };
    const updated = await prisma.portraitTask.update({ where: { id: task.id }, data: { status: "cancelled", cancelRequested: true, completedAt: new Date(), error: "用户已取消" }, include: { outputs: true } }) as unknown as PortraitTaskRow;
    activeTasks.get(task.requestId)?.abort();
    await settlePortraitBilling({ prisma, billing, task: updated, units: updated.completedCount }).catch(() => undefined);
    await markReferencesForCleanup(prisma, task.referenceAssetIds).catch(() => undefined);
    return { success: true, data: { task: serializeTask(await listTaskWithOutputs(prisma, userId, task.requestId) as PortraitTaskRow) } };
  });

  app.delete("/api/workflow/portraits/tasks/:requestId", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.userId;
    const params = z.object({ requestId: z.string().trim().min(8).max(128) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await listTaskWithOutputs(prisma, userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (!PORTRAIT_TERMINAL_STATUSES.has(task.status)) return reply.code(409).send({ error: "任务仍在生成中，暂不能删除" });
    for (const output of task.outputs ?? []) await deleteStoredImage(output.objectKey).catch(() => undefined);
    await prisma.portraitTask.delete({ where: { id: task.id } });
    return { success: true };
  });
}

export { cleanupExpiredPortraitReferences, isPortraitObjectKeyForUser };
