import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Metadata } from "sharp";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { requireUser } from "../auth/require-user.js";
import { deleteObject, getObject, loadS3Config, makeS3 } from "../storage/s3.js";
import { loadSharp } from "../runtime/resource-limits.js";
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
  HUMAN_IMAGE_ASPECT_RATIOS,
  HUMAN_IMAGE_MODEL,
  HUMAN_IMAGE_MODELS,
  HUMAN_IMAGE_RESOLUTIONS,
  humanImageModelSupports,
  humanImageOutputSize,
  type HumanImageAspectRatio,
  type HumanImageModel,
  type HumanImageResolution,
} from "./human-image-options.js";
import { resolveImageChargeRow, type WorkflowResourcePriceRow } from "./workflow-pricing.js";
import { deliveredImageResolution, minDeliveredPixels, pixelsFromSize } from "./image-delivered-tier.js";
import type { ImageResolutionLabel } from "./image-upstream-options.js";
import { portraitMaxAttempts, portraitRetryDelayMs, portraitTaskStaleMs } from "./portrait/index.js";
import { buildTryOnPrompt, TRY_ON_CONSENT_VERSION } from "./try-on-prompts.js";

const TRY_ON_REFERENCE_KINDS = ["garment_front", "garment_detail", "model"] as const;
const TRY_ON_ACTIVE_STATUSES = ["pending", "running"] as const;
const TRY_ON_TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const TRY_ON_MAX_COUNT = 4;
const TRY_ON_REFERENCE_MAX_PIXELS = 40_000_000;
const TRY_ON_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const TRY_ON_BLOB_TTL_MS = 15 * 60 * 1000;
const TRY_ON_TASK_KEEP_LIMIT = 30;
const TRY_ON_REAPER_INTERVAL_MS = 60_000;
const TRY_ON_REAPER_LOCK_KEY = "ai-assistant:try-on:reaper:lock";

type TryOnReferenceKind = (typeof TRY_ON_REFERENCE_KINDS)[number];
type TryOnTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

const tryOnReferenceMimeTypes = new Set([...IMAGE_REFERENCE_MIME_TYPES, "image/heic", "image/heif"]);
const humanModelValues = HUMAN_IMAGE_MODELS.map((item) => item.value) as [HumanImageModel, ...HumanImageModel[]];
const tryOnReferenceSchema = z.object({
  kind: z.enum(TRY_ON_REFERENCE_KINDS),
  image: z.object({
    b64: z.string().trim().min(1),
    mime: z
      .string()
      .trim()
      .regex(/^image\/[A-Za-z0-9.+-]+$/)
      .optional(),
  }),
});
const tryOnRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    model: z.enum(humanModelValues).default(HUMAN_IMAGE_MODEL),
    aspectRatio: z.enum(HUMAN_IMAGE_ASPECT_RATIOS),
    resolution: z.enum(HUMAN_IMAGE_RESOLUTIONS).default("2K"),
    count: z.number().int().min(1).max(TRY_ON_MAX_COUNT).default(1),
    garmentFrontAssetId: z.string().trim().min(1).max(128),
    garmentDetailAssetId: z.string().trim().min(1).max(128).optional(),
    modelAssetId: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(1200).optional().default(""),
    authorizationAccepted: z.boolean().optional().default(false),
    consentVersion: z.string().trim().max(64).optional(),
  })
  .superRefine((value, context) => {
    const ids = [value.garmentFrontAssetId, value.garmentDetailAssetId, value.modelAssetId].filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "素材不能重复" });
    }
    if (value.modelAssetId && (!value.authorizationAccepted || value.consentVersion !== TRY_ON_CONSENT_VERSION)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "必须确认已获得模特人物授权" });
    }
  });
const idParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const requestParamsSchema = z.object({ requestId: z.string().trim().min(8).max(128) });
const blobQuerySchema = z.object({ exp: z.coerce.number().int().positive(), sig: z.string().trim().min(1).max(128) });

interface TryOnBilling {
  reserveResource: (args: {
    operationId: string;
    userId: string;
    resourceKey: string;
    units: number;
  }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

interface TryOnRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: TryOnBilling;
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
  }) => Promise<GeneratedImage>;
}

interface TryOnReferenceRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: TryOnReferenceKind;
  readonly objectKey: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly expiresAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface TryOnOutputRow {
  readonly id: string;
  readonly taskId: string;
  readonly userId: string;
  readonly requestIndex: number;
  readonly objectKey: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

interface TryOnTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly count: number;
  readonly description: string;
  readonly effectivePrompt: string;
  readonly garmentFrontAssetId: string;
  readonly garmentDetailAssetId: string | null;
  readonly modelAssetId: string | null;
  readonly status: TryOnTaskStatus;
  readonly completedCount: number;
  readonly error: string | null;
  readonly consentVersion: string | null;
  readonly billingOperationId: string;
  readonly billingResourceKey: string;
  readonly billingReservedUnits: number;
  readonly billingSettledUnits: number;
  readonly billingStatus: string;
  readonly cancelRequested: boolean;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly outputs?: readonly TryOnOutputRow[];
}

function nowPlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof InsufficientBalanceError) return "余额不足，请充值";
  if (error instanceof Error) return error.message.slice(0, 300);
  return "服装试穿生成失败";
}

function referenceIds(
  task: Pick<TryOnTaskRow, "garmentFrontAssetId" | "garmentDetailAssetId" | "modelAssetId">,
): string[] {
  return [task.garmentFrontAssetId, task.garmentDetailAssetId, task.modelAssetId].filter((id): id is string =>
    Boolean(id),
  );
}

function blobSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret =
    env.TRY_ON_BLOB_SIGNING_SECRET?.trim() || env.PORTRAIT_BLOB_SIGNING_SECRET?.trim() || env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) throw new Error("try-on blob signing secret is not configured");
  return secret;
}

function blobSignature(
  kind: "reference" | "output",
  id: string,
  objectKey: string,
  exp: number,
  env?: NodeJS.ProcessEnv,
): string {
  return createHmac("sha256", blobSecret(env)).update(`${kind}:${id}:${objectKey}:${exp}`).digest("hex");
}

function blobUrl(kind: "reference" | "output", id: string, objectKey: string, env?: NodeJS.ProcessEnv): string {
  const exp = Math.floor((Date.now() + TRY_ON_BLOB_TTL_MS) / 1000);
  const sig = blobSignature(kind, id, objectKey, exp, env);
  return `/api/workflow/try-ons/${kind === "reference" ? "references" : "outputs"}/${encodeURIComponent(id)}/blob?exp=${exp}&sig=${sig}`;
}

function validBlobSignature(
  kind: "reference" | "output",
  id: string,
  objectKey: string,
  exp: number,
  sig: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(blobSignature(kind, id, objectKey, exp, env));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isTryOnObjectKeyForUser(value: string, userId: string, kind: "references" | "outputs"): boolean {
  if (!value.startsWith(`workflow/try-ons/${kind}/`) || value.includes("\\") || value.includes("..")) return false;
  const parts = value.split("/");
  return parts.length >= 6 && parts[3] === userId && parts.every((part) => part.length > 0 && part !== ".");
}

function serializeReference(row: TryOnReferenceRow) {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    previewUrl: blobUrl("reference", row.id, row.objectKey),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeOutput(row: TryOnOutputRow) {
  return {
    id: row.id,
    index: row.requestIndex,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    originalUrl: blobUrl("output", row.id, row.objectKey),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeTask(row: TryOnTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    model: row.model,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    count: row.count,
    description: row.description,
    garmentFrontAssetId: row.garmentFrontAssetId,
    garmentDetailAssetId: row.garmentDetailAssetId,
    modelAssetId: row.modelAssetId,
    status: row.status,
    completedCount: row.completedCount,
    error: row.error,
    billingStatus: row.billingStatus,
    outputs: (row.outputs ?? [])
      .slice()
      .sort((a, b) => a.requestIndex - b.requestIndex)
      .map(serializeOutput),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function taskWithOutputs(prisma: PrismaClient, userId: string, requestId: string): Promise<TryOnTaskRow | null> {
  return prisma.tryOnTask.findFirst({
    where: { userId, requestId },
    include: { outputs: { orderBy: { requestIndex: "asc" } } },
  }) as unknown as Promise<TryOnTaskRow | null>;
}

async function loadRoleReferences(
  prisma: PrismaClient,
  userId: string,
  task: Pick<TryOnTaskRow, "garmentFrontAssetId" | "garmentDetailAssetId" | "modelAssetId">,
): Promise<TryOnReferenceRow[]> {
  const expected: readonly { id: string; kind: TryOnReferenceKind }[] = [
    { id: task.garmentFrontAssetId, kind: "garment_front" },
    ...(task.garmentDetailAssetId ? [{ id: task.garmentDetailAssetId, kind: "garment_detail" as const }] : []),
    ...(task.modelAssetId ? [{ id: task.modelAssetId, kind: "model" as const }] : []),
  ];
  const rows = (await prisma.tryOnReferenceAsset.findMany({
    where: { userId, id: { in: expected.map((item) => item.id) }, deletedAt: null },
  })) as unknown as TryOnReferenceRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== expected.length || expected.some((item) => byId.get(item.id)?.kind !== item.kind)) {
    throw new Error("试穿素材不存在、类型不匹配或无权访问");
  }
  return expected.map((item) => byId.get(item.id)!);
}

async function markReferencesForCleanup(prisma: PrismaClient, ids: readonly string[]): Promise<void> {
  await prisma.tryOnReferenceAsset.updateMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    data: { expiresAt: nowPlus(TRY_ON_REFERENCE_TTL_MS) },
  });
}

async function cleanupExpiredReferences(
  prisma: PrismaClient,
  deleteStoredImage: (key: string) => Promise<void>,
): Promise<number> {
  const rows = (await prisma.tryOnReferenceAsset.findMany({
    where: { deletedAt: null, expiresAt: { lte: new Date() } },
    take: 100,
  })) as unknown as TryOnReferenceRow[];
  let removed = 0;
  for (const row of rows) {
    const active = await prisma.tryOnTask.findFirst({
      where: {
        status: { in: [...TRY_ON_ACTIVE_STATUSES] },
        OR: [{ garmentFrontAssetId: row.id }, { garmentDetailAssetId: row.id }, { modelAssetId: row.id }],
      },
      select: { id: true },
    });
    if (active) continue;
    await deleteStoredImage(row.objectKey).catch(() => undefined);
    await prisma.tryOnReferenceAsset.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), expiresAt: null },
    });
    removed += 1;
  }
  return removed;
}

function normalizeResolution(value: string): ImageResolutionLabel {
  const normalized = value.trim().toUpperCase();
  return normalized === "1K" || normalized === "2K" || normalized === "4K" ? normalized : "2K";
}

async function resolveSettleKey(prisma: PrismaClient, billing: TryOnBilling, task: TryOnTaskRow): Promise<string> {
  try {
    const outputs = await prisma.tryOnOutput.findMany({
      where: { taskId: task.id },
      select: { width: true, height: true },
    });
    const deliveredPixels = minDeliveredPixels(outputs.map((output) => `${output.width}x${output.height}`));
    const requested = normalizeResolution(task.resolution);
    const settled = deliveredImageResolution({
      requested,
      deliveredPixels,
      pixelsForResolution: (resolution) =>
        pixelsFromSize(
          humanImageOutputSize(resolution as HumanImageResolution, task.aspectRatio as HumanImageAspectRatio),
        ),
    });
    if (settled === requested) return task.billingResourceKey;
    const rows = billing.listResourcePrices ? ((await billing.listResourcePrices()).data ?? []) : [];
    return resolveImageChargeRow(rows, { resolution: settled, model: task.model }).resourceKey;
  } catch {
    return task.billingResourceKey;
  }
}

async function settleBilling(
  prisma: PrismaClient,
  billing: TryOnBilling,
  task: TryOnTaskRow,
  units: number,
): Promise<void> {
  const current = (await prisma.tryOnTask.findUnique({ where: { id: task.id } })) as unknown as TryOnTaskRow | null;
  if (!current || current.billingStatus === "settled" || current.billingStatus === "refunded") return;
  if (units > 0) {
    const resourceKey = await resolveSettleKey(prisma, billing, current);
    await billing.settleResource({ operationId: current.billingOperationId, resourceKey, units });
    await prisma.tryOnTask.update({
      where: { id: current.id },
      data: { billingStatus: "settled", billingSettledUnits: units, billingResourceKey: resourceKey },
    });
  } else {
    await billing.refundResource(current.billingOperationId);
    await prisma.tryOnTask.update({
      where: { id: current.id },
      data: { billingStatus: "refunded", billingSettledUnits: 0 },
    });
  }
}

async function retryGeneration<T>(work: () => Promise<T>, maxAttempts: number, retryDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableImageGenerationError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError;
}

async function runTryOnTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: TryOnBilling;
  readonly fetchFn: typeof fetch;
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly storeImage: NonNullable<TryOnRouteDeps["storeImage"]>;
  readonly loadStoredImage: (key: string) => Promise<Buffer>;
  readonly callImageEdit: NonNullable<TryOnRouteDeps["callImageEdit"]>;
}): Promise<void> {
  const sharp = await loadSharp();
  const task = (await args.prisma.tryOnTask.findUnique({
    where: { id: args.taskId },
    include: { outputs: true },
  })) as unknown as TryOnTaskRow | null;
  if (!task) return;
  const existing = (task.outputs ?? []).slice();
  let completedCount = existing.length;
  try {
    const references = await loadRoleReferences(args.prisma, task.userId, task);
    if (references.some((reference) => !isTryOnObjectKeyForUser(reference.objectKey, task.userId, "references")))
      throw new Error("试穿素材存储位置不合法");
    const filenames = [
      "garment-front.jpg",
      ...(task.garmentDetailAssetId ? ["garment-detail.jpg"] : []),
      ...(task.modelAssetId ? ["model-reference.jpg"] : []),
    ];
    const referenceImages = await Promise.all(
      references.map(async (reference, index) => ({
        b64: (await args.loadStoredImage(reference.objectKey)).toString("base64"),
        mime: reference.mime,
        filename: filenames[index],
      })),
    );
    const config = loadImageGenerationConfigForModel(task.model);
    await args.prisma.tryOnTask.update({ where: { id: task.id }, data: { status: "running", error: null } });
    for (let requestIndex = 0; requestIndex < task.count; requestIndex += 1) {
      if (existing.some((output) => output.requestIndex === requestIndex)) continue;
      const current = (await args.prisma.tryOnTask.findUnique({
        where: { id: task.id },
      })) as unknown as TryOnTaskRow | null;
      if (!current || current.cancelRequested || current.status === "cancelled" || args.signal.aborted)
        throw new Error("__TRY_ON_CANCELLED__");
      const generated = await retryGeneration(
        () =>
          args.callImageEdit({
            config,
            prompt: task.effectivePrompt,
            referenceImages,
            fetchFn: args.fetchFn,
            size: humanImageOutputSize(
              task.resolution as HumanImageResolution,
              task.aspectRatio as HumanImageAspectRatio,
            ),
            signal: args.signal,
          }),
        args.maxAttempts,
        args.retryDelayMs,
      );
      const stored = await args.storeImage({
        image: generated,
        userId: task.userId,
        requestId: task.requestId,
        requestIndex,
        fetchFn: args.fetchFn,
        namespace: "workflow/try-ons/outputs",
        acl: "private",
      });
      if (!stored.objectKey || !isTryOnObjectKeyForUser(stored.objectKey, task.userId, "outputs"))
        throw new Error("试穿结果存储位置不合法");
      const outputBuffer = await args.loadStoredImage(stored.objectKey);
      const metadata = await sharp(outputBuffer, { limitInputPixels: TRY_ON_REFERENCE_MAX_PIXELS }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("生成结果不是有效图片");
      await args.prisma.tryOnOutput.upsert({
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
      await args.prisma.tryOnTask.update({ where: { id: task.id }, data: { completedCount, error: null } });
    }
    await settleBilling(args.prisma, args.billing, task, completedCount);
    await args.prisma.tryOnTask.update({
      where: { id: task.id },
      data: { status: "completed", completedCount, completedAt: new Date(), error: null },
    });
    await markReferencesForCleanup(args.prisma, referenceIds(task));
  } catch (error) {
    const latest = (await args.prisma.tryOnTask.findUnique({
      where: { id: task.id },
    })) as unknown as TryOnTaskRow | null;
    const cancelled =
      args.signal.aborted ||
      latest?.cancelRequested ||
      latest?.status === "cancelled" ||
      (error instanceof Error && error.message === "__TRY_ON_CANCELLED__");
    const status: TryOnTaskStatus = cancelled ? "cancelled" : completedCount > 0 ? "partial" : "failed";
    await settleBilling(args.prisma, args.billing, task, completedCount).catch(() => undefined);
    await args.prisma.tryOnTask
      .update({
        where: { id: task.id },
        data: {
          status,
          completedCount,
          completedAt: new Date(),
          error: cancelled ? "用户已取消" : safeErrorMessage(error),
        },
      })
      .catch(() => undefined);
    await markReferencesForCleanup(args.prisma, referenceIds(task)).catch(() => undefined);
  }
}

export async function tryOnWorkflowRoutes(app: FastifyInstance, deps: TryOnRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing =
    deps.billing ??
    createBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
  const fetchFn = deps.fetchFn ?? fetch;
  const storeImage = deps.storeImage ?? storeWorkflowImageService;
  const loadStoredImage = deps.loadStoredImage ?? ((key: string) => getObject(makeS3(loadS3Config()), key));
  const deleteStoredImage = deps.deleteStoredImage ?? ((key: string) => deleteObject(makeS3(loadS3Config()), key));
  const callImageEdit =
    deps.callImageEdit ?? ((args: Parameters<typeof callImageEditService>[0]) => callImageEditService(args));
  const scheduleTask =
    deps.scheduleTask ??
    ((work: () => Promise<void>) => {
      void work().catch(() => undefined);
    });
  const retryDelayMs = deps.retryDelayMs ?? portraitRetryDelayMs();
  const maxAttempts = deps.maxAttempts ?? portraitMaxAttempts();
  const activeTasks = new Map<string, AbortController>();

  const listPriceRows = async (): Promise<readonly WorkflowResourcePriceRow[]> => {
    if (!billing.listResourcePrices) return [];
    try {
      return (await billing.listResourcePrices()).data ?? [];
    } catch (error) {
      app.log.warn({ error: safeErrorMessage(error) }, "try-on pricing unavailable; using generic image prices");
      return [];
    }
  };

  const schedule = (task: TryOnTaskRow) => {
    if (activeTasks.has(task.requestId) || TRY_ON_TERMINAL_STATUSES.has(task.status)) return;
    const controller = new AbortController();
    activeTasks.set(task.requestId, controller);
    scheduleTask(async () => {
      try {
        await runTryOnTask({
          prisma,
          billing,
          fetchFn,
          taskId: task.id,
          signal: controller.signal,
          retryDelayMs,
          maxAttempts,
          storeImage,
          loadStoredImage,
          callImageEdit,
        });
      } finally {
        if (activeTasks.get(task.requestId) === controller) activeTasks.delete(task.requestId);
      }
    });
  };

  const recover = async (rows: readonly TryOnTaskRow[]) => {
    for (const row of rows) {
      if (row.status === "pending") {
        try {
          await billing.reserveResource({
            operationId: row.billingOperationId,
            userId: row.userId,
            resourceKey: row.billingResourceKey,
            units: row.count,
          });
          const reserved = (await prisma.tryOnTask.update({
            where: { id: row.id },
            data: { status: "running", billingReservedUnits: row.count, billingStatus: "reserved", error: null },
          })) as unknown as TryOnTaskRow;
          schedule(reserved);
        } catch (error) {
          await prisma.tryOnTask
            .update({
              where: { id: row.id },
              data: {
                status: "failed",
                billingStatus: "reserve_failed",
                completedAt: new Date(),
                error: safeErrorMessage(error),
              },
            })
            .catch(() => undefined);
          await markReferencesForCleanup(prisma, referenceIds(row)).catch(() => undefined);
        }
      } else {
        schedule(row);
      }
    }
  };

  const cleanupTimer = setInterval(
    () => void cleanupExpiredReferences(prisma, deleteStoredImage).catch(() => undefined),
    60 * 60 * 1000,
  );
  cleanupTimer.unref?.();
  void cleanupExpiredReferences(prisma, deleteStoredImage).catch(() => undefined);

  const reaperTimer = deps.redis
    ? setInterval(() => {
        void (async () => {
          const got = await deps.redis!.set(TRY_ON_REAPER_LOCK_KEY, "1", "EX", 55, "NX").catch(() => null);
          if (got !== "OK") return;
          const threshold = new Date(Date.now() - portraitTaskStaleMs());
          const [active, unsettled] = await Promise.all([
            prisma.tryOnTask.findMany({
              where: { status: { in: [...TRY_ON_ACTIVE_STATUSES] }, updatedAt: { lt: threshold } },
              orderBy: { createdAt: "asc" },
              take: 200,
            }),
            prisma.tryOnTask.findMany({
              where: {
                status: { in: [...TRY_ON_TERMINAL_STATUSES] },
                billingStatus: "reserved",
                updatedAt: { lt: threshold },
              },
              orderBy: { updatedAt: "asc" },
              take: 200,
            }),
          ]);
          await recover(active as unknown as TryOnTaskRow[]);
          for (const task of unsettled as unknown as TryOnTaskRow[])
            await settleBilling(prisma, billing, task, task.completedCount).catch(() => undefined);
        })().catch((error) => app.log.warn({ error: safeErrorMessage(error) }, "try-on reaper tick failed"));
      }, TRY_ON_REAPER_INTERVAL_MS)
    : undefined;
  reaperTimer?.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    if (reaperTimer) clearInterval(reaperTimer);
    for (const controller of activeTasks.values()) controller.abort();
    activeTasks.clear();
  });

  app.get("/api/workflow/try-ons/options", { preHandler: requireUser }, async () => {
    const priceRows = await listPriceRows();
    const pricingByModel: Record<string, Partial<Record<HumanImageResolution, number>>> = {};
    for (const model of HUMAN_IMAGE_MODELS) {
      pricingByModel[model.value] = Object.fromEntries(
        HUMAN_IMAGE_RESOLUTIONS.filter((resolution) => humanImageModelSupports(model.value, resolution)).map(
          (resolution) => [resolution, resolveImageChargeRow(priceRows, { resolution, model: model.value }).rate],
        ),
      );
    }
    return {
      success: true,
      data: {
        model: HUMAN_IMAGE_MODEL,
        models: HUMAN_IMAGE_MODELS,
        consentVersion: TRY_ON_CONSENT_VERSION,
        aspectRatios: HUMAN_IMAGE_ASPECT_RATIOS,
        resolutions: HUMAN_IMAGE_RESOLUTIONS,
        pricing: Object.fromEntries(
          HUMAN_IMAGE_RESOLUTIONS.map((resolution) => [resolution, resolveImageChargeRow(priceRows, { resolution })]),
        ),
        pricingByModel,
      },
    };
  });

  app.get("/api/workflow/try-ons/references/:id/blob", async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = (await prisma.tryOnReferenceAsset.findUnique({
      where: { id: params.data.id },
    })) as unknown as TryOnReferenceRow | null;
    if (
      !row ||
      row.deletedAt ||
      !isTryOnObjectKeyForUser(row.objectKey, row.userId, "references") ||
      !validBlobSignature("reference", row.id, row.objectKey, query.data.exp, query.data.sig)
    )
      return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(row.mime)
        .send(await loadStoredImage(row.objectKey));
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.get("/api/workflow/try-ons/outputs/:id/blob", async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = (await prisma.tryOnOutput.findUnique({
      where: { id: params.data.id },
    })) as unknown as TryOnOutputRow | null;
    if (
      !row ||
      !isTryOnObjectKeyForUser(row.objectKey, row.userId, "outputs") ||
      !validBlobSignature("output", row.id, row.objectKey, query.data.exp, query.data.sig)
    )
      return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(row.mime)
        .header("Content-Disposition", `inline; filename="try-on-${row.requestIndex + 1}.png"`)
        .send(await loadStoredImage(row.objectKey));
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.post("/api/workflow/try-ons/references", { preHandler: requireUser }, async (req, reply) => {
    const sharp = await loadSharp();
    const userId = req.userId;
    const parsed = tryOnReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "试穿素材参数不合法" });
    const sourceBytes = Buffer.from(parsed.data.image.b64, "base64");
    if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > IMAGE_REFERENCE_MAX_BYTES)
      return reply.code(400).send({ error: "图片大小需在 10MB 以内" });
    const sourceMime = parsed.data.image.mime?.split(";", 1)[0]?.trim().toLowerCase() || "image/jpeg";
    if (!tryOnReferenceMimeTypes.has(sourceMime))
      return reply.code(400).send({ error: "图片仅支持 JPG、PNG、WEBP、BMP、TIFF、GIF 或 HEIC" });
    let normalized: Buffer;
    let metadata: Metadata;
    try {
      metadata = await sharp(sourceBytes, {
        limitInputPixels: TRY_ON_REFERENCE_MAX_PIXELS,
        animated: false,
      }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > TRY_ON_REFERENCE_MAX_PIXELS)
        throw new Error("invalid dimensions");
      normalized = await sharp(sourceBytes, { limitInputPixels: TRY_ON_REFERENCE_MAX_PIXELS, animated: false })
        .rotate()
        .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
        .toBuffer();
    } catch {
      return reply.code(400).send({ error: "图片不可读取或像素尺寸过大" });
    }
    if (normalized.byteLength > IMAGE_REFERENCE_MAX_BYTES)
      return reply.code(400).send({ error: "图片处理后超过 10MB" });
    const normalizedMetadata = await sharp(normalized).metadata();
    const requestId = `try-on-reference-${randomUUID()}`;
    let stored: StoredImage;
    try {
      stored = await storeImage({
        image: { kind: "b64", b64: normalized.toString("base64"), mime: "image/jpeg" },
        userId,
        requestId,
        requestIndex: 0,
        fetchFn,
        namespace: "workflow/try-ons/references",
        acl: "private",
      });
    } catch {
      return reply.code(502).send({ error: "试穿素材存储失败" });
    }
    if (!stored.objectKey || !isTryOnObjectKeyForUser(stored.objectKey, userId, "references"))
      return reply.code(502).send({ error: "试穿素材存储位置不合法" });
    const row = (await prisma.tryOnReferenceAsset.create({
      data: {
        userId,
        kind: parsed.data.kind,
        objectKey: stored.objectKey,
        mime: "image/jpeg",
        width: normalizedMetadata.width ?? metadata.width!,
        height: normalizedMetadata.height ?? metadata.height!,
        sizeBytes: normalized.byteLength,
        expiresAt: nowPlus(TRY_ON_REFERENCE_TTL_MS),
      },
    })) as unknown as TryOnReferenceRow;
    return { success: true, data: { asset: serializeReference(row) } };
  });

  app.delete("/api/workflow/try-ons/references/:id", { preHandler: requireUser }, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "试穿素材参数不合法" });
    const row = (await prisma.tryOnReferenceAsset.findFirst({
      where: { id: params.data.id, userId: req.userId, deletedAt: null },
    })) as unknown as TryOnReferenceRow | null;
    if (!row) return reply.code(404).send({ error: "试穿素材不存在" });
    const active = await prisma.tryOnTask.findFirst({
      where: {
        userId: req.userId,
        status: { in: [...TRY_ON_ACTIVE_STATUSES] },
        OR: [{ garmentFrontAssetId: row.id }, { garmentDetailAssetId: row.id }, { modelAssetId: row.id }],
      },
      select: { id: true },
    });
    if (active) return reply.code(409).send({ error: "任务生成中，暂不能删除素材" });
    await deleteStoredImage(row.objectKey).catch(() => undefined);
    await prisma.tryOnReferenceAsset.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), expiresAt: null },
    });
    return { success: true };
  });

  app.get("/api/workflow/try-ons/state", { preHandler: requireUser }, async (req) => {
    const active = (await prisma.tryOnTask.findMany({
      where: { userId: req.userId, status: { in: [...TRY_ON_ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
      take: 50,
    })) as unknown as TryOnTaskRow[];
    await recover(active);
    const [referenceRows, tasks] = await Promise.all([
      prisma.tryOnReferenceAsset.findMany({
        where: { userId: req.userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.tryOnTask.findMany({
        where: { userId: req.userId },
        include: { outputs: { orderBy: { requestIndex: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: TRY_ON_TASK_KEEP_LIMIT,
      }),
    ]);
    const seenKinds = new Set<string>();
    const references = (referenceRows as unknown as TryOnReferenceRow[]).filter(
      (row) => !seenKinds.has(row.kind) && Boolean(seenKinds.add(row.kind)),
    );
    return {
      success: true,
      data: {
        references: references.map(serializeReference),
        tasks: (tasks as unknown as TryOnTaskRow[]).map(serializeTask),
      },
    };
  });

  app.post("/api/workflow/try-ons/generate", { preHandler: requireUser }, async (req, reply) => {
    const parsed = tryOnRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "试穿生成参数不完整；上传模特图时必须确认人物授权" });
    if (!humanImageModelSupports(parsed.data.model, parsed.data.resolution)) {
      const model = HUMAN_IMAGE_MODELS.find((item) => item.value === parsed.data.model)!;
      return reply.code(400).send({ error: `${model.label} 暂不支持 ${parsed.data.resolution}` });
    }
    const existing = await taskWithOutputs(prisma, req.userId, parsed.data.requestId);
    if (existing)
      return reply
        .code(TRY_ON_TERMINAL_STATUSES.has(existing.status) ? 200 : 202)
        .send({ success: true, data: { task: serializeTask(existing) } });
    const crossUser = await prisma.tryOnTask.findUnique({
      where: { requestId: parsed.data.requestId },
      select: { id: true },
    });
    if (crossUser) return reply.code(409).send({ error: "请求编号已被使用" });
    const roleInput = {
      garmentFrontAssetId: parsed.data.garmentFrontAssetId,
      garmentDetailAssetId: parsed.data.garmentDetailAssetId ?? null,
      modelAssetId: parsed.data.modelAssetId ?? null,
    };
    const references = await loadRoleReferences(prisma, req.userId, roleInput).catch(() => null);
    if (!references) return reply.code(404).send({ error: "试穿素材不存在、类型不匹配或无权访问" });
    const effectivePrompt = buildTryOnPrompt({
      aspectRatio: parsed.data.aspectRatio,
      hasGarmentDetail: Boolean(parsed.data.garmentDetailAssetId),
      hasModelReference: Boolean(parsed.data.modelAssetId),
      description: parsed.data.description,
    });
    const resourceKey = resolveImageChargeRow(await listPriceRows(), {
      resolution: parsed.data.resolution,
      model: parsed.data.model,
    }).resourceKey;
    const billingOperationId = `try-on:${parsed.data.requestId}`;
    let task: TryOnTaskRow | null = null;
    let reserved = false;
    try {
      task = (await prisma.tryOnTask.create({
        data: {
          userId: req.userId,
          requestId: parsed.data.requestId,
          model: parsed.data.model,
          aspectRatio: parsed.data.aspectRatio,
          resolution: parsed.data.resolution,
          count: parsed.data.count,
          description: parsed.data.description,
          effectivePrompt,
          ...roleInput,
          status: "pending",
          consentVersion: parsed.data.modelAssetId ? TRY_ON_CONSENT_VERSION : null,
          billingOperationId,
          billingResourceKey: resourceKey,
          billingReservedUnits: 0,
          billingSettledUnits: 0,
          billingStatus: "pending",
        },
        include: { outputs: true },
      })) as unknown as TryOnTaskRow;
      await billing.reserveResource({
        operationId: billingOperationId,
        userId: req.userId,
        resourceKey,
        units: parsed.data.count,
      });
      reserved = true;
      task = (await prisma.tryOnTask.update({
        where: { id: task.id },
        data: { status: "running", billingReservedUnits: parsed.data.count, billingStatus: "reserved" },
        include: { outputs: true },
      })) as unknown as TryOnTaskRow;
    } catch (error) {
      if (reserved) await billing.refundResource(billingOperationId).catch(() => undefined);
      if (task?.id) await prisma.tryOnTask.delete({ where: { id: task.id } }).catch(() => undefined);
      const duplicate = await taskWithOutputs(prisma, req.userId, parsed.data.requestId).catch(() => null);
      if (duplicate) return reply.code(202).send({ success: true, data: { task: serializeTask(duplicate) } });
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "余额不足，请充值" });
      return reply.code(502).send({ error: "服装试穿任务创建失败" });
    }
    schedule(task);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task) } });
  });

  app.post("/api/workflow/try-ons/tasks/:requestId/cancel", { preHandler: requireUser }, async (req, reply) => {
    const params = requestParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await taskWithOutputs(prisma, req.userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (TRY_ON_TERMINAL_STATUSES.has(task.status)) return { success: true, data: { task: serializeTask(task) } };
    const updated = (await prisma.tryOnTask.update({
      where: { id: task.id },
      data: { status: "cancelled", cancelRequested: true, completedAt: new Date(), error: "用户已取消" },
      include: { outputs: true },
    })) as unknown as TryOnTaskRow;
    activeTasks.get(task.requestId)?.abort();
    await settleBilling(prisma, billing, updated, updated.completedCount).catch(() => undefined);
    await markReferencesForCleanup(prisma, referenceIds(task)).catch(() => undefined);
    return {
      success: true,
      data: { task: serializeTask((await taskWithOutputs(prisma, req.userId, task.requestId))!) },
    };
  });

  app.delete("/api/workflow/try-ons/tasks/:requestId", { preHandler: requireUser }, async (req, reply) => {
    const params = requestParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await taskWithOutputs(prisma, req.userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (!TRY_ON_TERMINAL_STATUSES.has(task.status))
      return reply.code(409).send({ error: "任务仍在生成中，暂不能删除" });
    for (const output of task.outputs ?? []) await deleteStoredImage(output.objectKey).catch(() => undefined);
    await prisma.tryOnTask.delete({ where: { id: task.id } });
    return { success: true };
  });
}

export { cleanupExpiredReferences };
