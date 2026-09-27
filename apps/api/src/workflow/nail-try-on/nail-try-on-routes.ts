import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Metadata } from "sharp";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createUnmeteredImageUsage, InsufficientBalanceError } from "../_shared/unmetered-image-usage.js";
import { requireUser } from "../../auth/require-user.js";
import { deleteObject, getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import { createImageUrlSigner, type ImageUrlSigner } from "../../storage/cos-image-url.js";
import { sendImageBlob } from "../_shared/image-blob-response.js";
import { loadSharp } from "../../runtime/resource-limits.js";
import {
  callImageEdit as callImageEditService,
  GPT_IMAGE_MODEL,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_REFERENCE_MIME_TYPES,
  isRetryableImageGenerationError,
  loadImageGenerationConfigForModel,
  storeWorkflowImage as storeWorkflowImageService,
  type GeneratedImage,
  type ImageBinaryInput,
  type ImageGenerationConfig,
  type StoredImage,
} from "../_shared/image-service.js";
// imageModelSupportsMask 不在门面 image-service.js 里（门面明令新代码走细分层，别补 re-export）。
import { imageModelSupportsMask } from "../_shared/image-service-providers.js";
import {
  HUMAN_IMAGE_ASPECT_RATIOS,
  HUMAN_IMAGE_MODELS,
  HUMAN_IMAGE_RESOLUTIONS,
  humanImageModelSupports,
  humanImageOutputSize,
  type HumanImageAspectRatio,
  type HumanImageModel,
  type HumanImageResolution,
} from "../_shared/human-image-options.js";
import { resolveImageChargeRow, type WorkflowResourcePriceRow } from "../_shared/workflow-pricing.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  portraitMaxAttempts,
  portraitReservationTtlSeconds,
  portraitRetryDelayMs,
  portraitTaskStaleMs,
} from "../portrait/index.js";
import { buildNailTryOnPrompt, NAIL_TRY_ON_CONSENT_VERSION } from "./nail-try-on-prompts.js";
const NAIL_REFERENCE_KINDS = ["hand", "nail_design"] as const;
const NAIL_ACTIVE_STATUSES = ["pending", "running"] as const;
const NAIL_TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const NAIL_MAX_COUNT = 4;
const NAIL_REFERENCE_MAX_PIXELS = 40_000_000;
const NAIL_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const NAIL_BLOB_TTL_MS = 15 * 60 * 1000;
const NAIL_TASK_KEEP_LIMIT = 30;
// 默认 gpt-image-2：唯一支持独立 mask 的协议，锁手靠它。选到别的模型会降级为整图编辑。
const NAIL_DEFAULT_MODEL = GPT_IMAGE_MODEL as HumanImageModel;

type NailReferenceKind = (typeof NAIL_REFERENCE_KINDS)[number];
type NailTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

const nailReferenceMimeTypes = new Set([...IMAGE_REFERENCE_MIME_TYPES, "image/heic", "image/heif"]);
const humanModelValues = HUMAN_IMAGE_MODELS.map((item) => item.value) as [HumanImageModel, ...HumanImageModel[]];
const nailReferenceSchema = z.object({
  kind: z.enum(NAIL_REFERENCE_KINDS),
  image: z.object({
    b64: z.string().trim().min(1),
    mime: z
      .string()
      .trim()
      .regex(/^image\/[A-Za-z0-9.+-]+$/)
      .optional(),
  }),
});
const nailRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    model: z.enum(humanModelValues).default(NAIL_DEFAULT_MODEL),
    aspectRatio: z.enum(HUMAN_IMAGE_ASPECT_RATIOS),
    resolution: z.enum(HUMAN_IMAGE_RESOLUTIONS).default("2K"),
    count: z.number().int().min(1).max(NAIL_MAX_COUNT).default(1),
    handAssetId: z.string().trim().min(1).max(128),
    nailDesignAssetId: z.string().trim().min(1).max(128).optional(),
    // 蒙版随请求内联下发（无损 PNG，带 alpha），不走 reference 的 JPEG-92 归一路径。
    mask: z.object({ b64: z.string().trim().min(1) }),
    description: z.string().trim().max(1200).optional().default(""),
    authorizationAccepted: z.boolean().optional().default(false),
    consentVersion: z.string().trim().max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.nailDesignAssetId && value.nailDesignAssetId === value.handAssetId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "素材不能重复" });
    }
    // 手部照片即「主体」，试甲台每次生成都要确认授权，不像试穿仅在有主体图时才要。
    if (!value.authorizationAccepted || value.consentVersion !== NAIL_TRY_ON_CONSENT_VERSION) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "必须确认手部照片使用授权" });
    }
  });
const idParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const requestParamsSchema = z.object({ requestId: z.string().trim().min(8).max(128) });
const blobQuerySchema = z.object({ exp: z.coerce.number().int().positive(), sig: z.string().trim().min(1).max(128) });
interface NailBilling {
  reserveResource: (args: {
    operationId: string;
    userId: string;
    resourceKey: string;
    units: number;
    reservationTtlSeconds?: number;
  }) => Promise<{ reserved: number }>;
  settleResource: (args: { operationId: string; resourceKey: string; units: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

interface NailRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: NailBilling;
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
  readonly signImageUrl?: ImageUrlSigner;
  readonly deleteStoredImage?: (objectKey: string) => Promise<void>;
  readonly callImageEdit?: (args: {
    config: ImageGenerationConfig;
    prompt: string;
    referenceImages: readonly ImageBinaryInput[];
    mask?: ImageBinaryInput;
    fetchFn: typeof fetch;
    size: string;
    signal: AbortSignal;
  }) => Promise<GeneratedImage>;
}
interface NailReferenceRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: NailReferenceKind;
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

interface NailOutputRow {
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
interface NailTaskRow {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly count: number;
  readonly description: string;
  readonly effectivePrompt: string;
  readonly handAssetId: string;
  readonly nailDesignAssetId: string | null;
  readonly maskObjectKey: string;
  readonly status: NailTaskStatus;
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
  readonly outputs?: readonly NailOutputRow[];
}

function nowPlus(ms: number): Date {
  return new Date(Date.now() + ms);
}

function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "美甲试戴生成失败", 300);
}

function referenceIds(task: Pick<NailTaskRow, "handAssetId" | "nailDesignAssetId">): string[] {
  return [task.handAssetId, task.nailDesignAssetId].filter((id): id is string => Boolean(id));
}

function parseSize(size: string): { readonly width: number; readonly height: number } | null {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}
function blobSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret =
    env.NAIL_TRY_ON_BLOB_SIGNING_SECRET?.trim() ||
    env.PORTRAIT_BLOB_SIGNING_SECRET?.trim() ||
    env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) throw new Error("nail try-on blob signing secret is not configured");
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
  const exp = Math.floor((Date.now() + NAIL_BLOB_TTL_MS) / 1000);
  const sig = blobSignature(kind, id, objectKey, exp, env);
  return `/api/workflow/nail-try-ons/${kind === "reference" ? "references" : "outputs"}/${encodeURIComponent(id)}/blob?exp=${exp}&sig=${sig}`;
}

/** 素材库若接入，用同一条签名链接，别在别处重签。 */
export const nailTryOnBlobUrl = blobUrl;

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

// masks 命名空间是试甲台独有的（试穿只有 references/outputs），存无损蒙版 PNG。
export function isNailTryOnObjectKeyForUser(
  value: string,
  userId: string,
  kind: "references" | "outputs" | "masks",
): boolean {
  if (!value.startsWith(`workflow/nail-try-ons/${kind}/`) || value.includes("\\") || value.includes("..")) return false;
  const parts = value.split("/");
  return parts.length >= 6 && parts[3] === userId && parts.every((part) => part.length > 0 && part !== ".");
}
function serializeReference(row: NailReferenceRow) {
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

function serializeOutput(row: NailOutputRow) {
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

function serializeTask(row: NailTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    model: row.model,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    count: row.count,
    description: row.description,
    handAssetId: row.handAssetId,
    nailDesignAssetId: row.nailDesignAssetId,
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
async function taskWithOutputs(prisma: PrismaClient, userId: string, requestId: string): Promise<NailTaskRow | null> {
  return prisma.nailTryOnTask.findFirst({
    where: { userId, requestId },
    include: { outputs: { orderBy: { requestIndex: "asc" } } },
  }) as unknown as Promise<NailTaskRow | null>;
}

async function loadRoleReferences(
  prisma: PrismaClient,
  userId: string,
  task: Pick<NailTaskRow, "handAssetId" | "nailDesignAssetId">,
): Promise<NailReferenceRow[]> {
  // 顺序即 callImageEdit 的 image 顺序：image[0]=手（mask 对齐它），image[1]=美甲样式。
  const expected: readonly { id: string; kind: NailReferenceKind }[] = [
    { id: task.handAssetId, kind: "hand" },
    ...(task.nailDesignAssetId ? [{ id: task.nailDesignAssetId, kind: "nail_design" as const }] : []),
  ];
  const rows = (await prisma.nailTryOnReferenceAsset.findMany({
    where: { userId, id: { in: expected.map((item) => item.id) }, deletedAt: null },
  })) as unknown as NailReferenceRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== expected.length || expected.some((item) => byId.get(item.id)?.kind !== item.kind)) {
    throw new Error("试甲素材不存在、类型不匹配或无权访问");
  }
  return expected.map((item) => byId.get(item.id)!);
}

async function markReferencesForCleanup(prisma: PrismaClient, ids: readonly string[]): Promise<void> {
  await prisma.nailTryOnReferenceAsset.updateMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    data: { expiresAt: nowPlus(NAIL_REFERENCE_TTL_MS) },
  });
}
async function cleanupExpiredReferences(
  prisma: PrismaClient,
  deleteStoredImage: (key: string) => Promise<void>,
): Promise<number> {
  const rows = (await prisma.nailTryOnReferenceAsset.findMany({
    where: { deletedAt: null, expiresAt: { lte: new Date() } },
    take: 100,
  })) as unknown as NailReferenceRow[];
  let removed = 0;
  for (const row of rows) {
    const active = await prisma.nailTryOnTask.findFirst({
      where: {
        status: { in: [...NAIL_ACTIVE_STATUSES] },
        OR: [{ handAssetId: row.id }, { nailDesignAssetId: row.id }],
      },
      select: { id: true },
    });
    if (active) continue;
    await deleteStoredImage(row.objectKey).catch(() => undefined);
    await prisma.nailTryOnReferenceAsset.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), expiresAt: null },
    });
    removed += 1;
  }
  return removed;
}

async function settleBilling(
  prisma: PrismaClient,
  billing: NailBilling,
  task: NailTaskRow,
  units: number,
): Promise<void> {
  // 计费是 unmetered 死代码（全 0），这里只保留同构记账字段，不再算 resolution 降级价。
  const current = (await prisma.nailTryOnTask.findUnique({
    where: { id: task.id },
  })) as unknown as NailTaskRow | null;
  if (!current || current.billingStatus === "settled" || current.billingStatus === "refunded") return;
  if (units > 0) {
    await billing.settleResource({
      operationId: current.billingOperationId,
      resourceKey: current.billingResourceKey,
      units,
    });
    await prisma.nailTryOnTask.update({
      where: { id: current.id },
      data: { billingStatus: "settled", billingSettledUnits: units },
    });
  } else {
    await billing.refundResource(current.billingOperationId);
    await prisma.nailTryOnTask.update({
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

async function runNailTryOnTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: NailBilling;
  readonly fetchFn: typeof fetch;
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly storeImage: NonNullable<NailRouteDeps["storeImage"]>;
  readonly loadStoredImage: (key: string) => Promise<Buffer>;
  readonly callImageEdit: NonNullable<NailRouteDeps["callImageEdit"]>;
}): Promise<void> {
  const sharp = await loadSharp();
  const task = (await args.prisma.nailTryOnTask.findUnique({
    where: { id: args.taskId },
    include: { outputs: true },
  })) as unknown as NailTaskRow | null;
  if (!task) return;
  const existing = (task.outputs ?? []).slice();
  let completedCount = existing.length;
  try {
    const references = await loadRoleReferences(args.prisma, task.userId, task);
    if (references.some((reference) => !isNailTryOnObjectKeyForUser(reference.objectKey, task.userId, "references")))
      throw new Error("试甲素材存储位置不合法");
    if (!isNailTryOnObjectKeyForUser(task.maskObjectKey, task.userId, "masks"))
      throw new Error("蒙版存储位置不合法");
    const filenames = ["nail-hand.jpg", ...(task.nailDesignAssetId ? ["nail-design.jpg"] : [])];
    const referenceImages = await Promise.all(
      references.map(async (reference, index) => ({
        b64: (await args.loadStoredImage(reference.objectKey)).toString("base64"),
        mime: reference.mime,
        filename: filenames[index],
      })),
    );
    // 只有 openai 协议接受 mask；选到 Seedream/Qwen 时降级为整图编辑（手部锁定不保证，UI 已标注）。
    const maskInput: ImageBinaryInput | undefined = imageModelSupportsMask(task.model)
      ? { b64: (await args.loadStoredImage(task.maskObjectKey)).toString("base64"), mime: "image/png", filename: "nail-mask.png" }
      : undefined;
    const config = loadImageGenerationConfigForModel(task.model);
    await args.prisma.nailTryOnTask.update({ where: { id: task.id }, data: { status: "running", error: null } });
    for (let requestIndex = 0; requestIndex < task.count; requestIndex += 1) {
      if (existing.some((output) => output.requestIndex === requestIndex)) continue;
      const current = (await args.prisma.nailTryOnTask.findUnique({
        where: { id: task.id },
      })) as unknown as NailTaskRow | null;
      if (!current || current.cancelRequested || current.status === "cancelled" || args.signal.aborted)
        throw new Error("__NAIL_CANCELLED__");
      const generated = await retryGeneration(
        () =>
          args.callImageEdit({
            config,
            prompt: task.effectivePrompt,
            referenceImages,
            mask: maskInput,
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
        namespace: "workflow/nail-try-ons/outputs",
        acl: "private",
      });
      if (!stored.objectKey || !isNailTryOnObjectKeyForUser(stored.objectKey, task.userId, "outputs"))
        throw new Error("试甲结果存储位置不合法");
      const outputBuffer = await args.loadStoredImage(stored.objectKey);
      const metadata = await sharp(outputBuffer, { limitInputPixels: NAIL_REFERENCE_MAX_PIXELS }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("生成结果不是有效图片");
      await args.prisma.nailTryOnOutput.upsert({
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
      await args.prisma.nailTryOnTask.update({ where: { id: task.id }, data: { completedCount, error: null } });
    }
    await settleBilling(args.prisma, args.billing, task, completedCount);
    await args.prisma.nailTryOnTask.update({
      where: { id: task.id },
      data: { status: "completed", completedCount, completedAt: new Date(), error: null },
    });
    await markReferencesForCleanup(args.prisma, referenceIds(task));
  } catch (error) {
    const latest = (await args.prisma.nailTryOnTask.findUnique({
      where: { id: task.id },
    })) as unknown as NailTaskRow | null;
    const cancelled =
      args.signal.aborted ||
      latest?.cancelRequested ||
      latest?.status === "cancelled" ||
      (error instanceof Error && error.message === "__NAIL_CANCELLED__");
    const status: NailTaskStatus = cancelled ? "cancelled" : completedCount > 0 ? "partial" : "failed";
    await settleBilling(args.prisma, args.billing, task, completedCount).catch(() => undefined);
    await args.prisma.nailTryOnTask
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
export async function nailTryOnWorkflowRoutes(app: FastifyInstance, deps: NailRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createUnmeteredImageUsage();
  const fetchFn = deps.fetchFn ?? fetch;
  const storeImage = deps.storeImage ?? storeWorkflowImageService;
  const loadStoredImage = deps.loadStoredImage ?? ((key: string) => getObject(makeS3(loadS3Config()), key));
  const signImageUrl = deps.signImageUrl ?? createImageUrlSigner();
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
      app.log.warn({ error: safeErrorMessage(error) }, "nail try-on pricing unavailable; using generic image prices");
      return [];
    }
  };

  const schedule = (task: NailTaskRow) => {
    if (activeTasks.has(task.requestId) || NAIL_TERMINAL_STATUSES.has(task.status)) return;
    const controller = new AbortController();
    activeTasks.set(task.requestId, controller);
    scheduleTask(async () => {
      try {
        await runNailTryOnTask({
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
  const recover = async (rows: readonly NailTaskRow[]) => {
    for (const row of rows) {
      if (row.status === "pending") {
        try {
          await billing.reserveResource({
            operationId: row.billingOperationId,
            userId: row.userId,
            resourceKey: row.billingResourceKey,
            units: row.count,
            reservationTtlSeconds: portraitReservationTtlSeconds(row.count),
          });
          const reserved = (await prisma.nailTryOnTask.update({
            where: { id: row.id },
            data: { status: "running", billingReservedUnits: row.count, billingStatus: "reserved", error: null },
          })) as unknown as NailTaskRow;
          schedule(reserved);
        } catch (error) {
          await prisma.nailTryOnTask
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

  // 决定 A：不养常驻 reaper。/state 被轮询时顺手把「不在本进程跑、又超时」的任务收尸，
  // 其余活跃任务照常 recover（崩溃重启后可续跑）。省掉第 5 条常驻清理链。
  const failStale = async (task: NailTaskRow) => {
    await settleBilling(prisma, billing, task, task.completedCount).catch(() => undefined);
    await prisma.nailTryOnTask
      .update({
        where: { id: task.id },
        data: {
          status: task.completedCount > 0 ? "partial" : "failed",
          completedAt: new Date(),
          error: "任务超时，已自动结束，请重试",
        },
      })
      .catch(() => undefined);
    await markReferencesForCleanup(prisma, referenceIds(task)).catch(() => undefined);
  };
  const cleanupTimer = setInterval(
    () => void cleanupExpiredReferences(prisma, deleteStoredImage).catch(() => undefined),
    60 * 60 * 1000,
  );
  cleanupTimer.unref?.();
  void cleanupExpiredReferences(prisma, deleteStoredImage).catch(() => undefined);

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    for (const controller of activeTasks.values()) controller.abort();
    activeTasks.clear();
  });

  app.get("/api/workflow/nail-try-ons/options", { preHandler: requireUser }, async () => {
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
        model: NAIL_DEFAULT_MODEL,
        // supportsMask 让前端在选到非 openai 模型时提示「手部锁定不保证」。
        models: HUMAN_IMAGE_MODELS.map((model) => ({ ...model, supportsMask: imageModelSupportsMask(model.value) })),
        consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
        aspectRatios: HUMAN_IMAGE_ASPECT_RATIOS,
        resolutions: HUMAN_IMAGE_RESOLUTIONS,
        pricing: Object.fromEntries(
          HUMAN_IMAGE_RESOLUTIONS.map((resolution) => [resolution, resolveImageChargeRow(priceRows, { resolution })]),
        ),
        pricingByModel,
      },
    };
  });
  app.get("/api/workflow/nail-try-ons/references/:id/blob", async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = (await prisma.nailTryOnReferenceAsset.findUnique({
      where: { id: params.data.id },
    })) as unknown as NailReferenceRow | null;
    if (
      !row ||
      row.deletedAt ||
      !isNailTryOnObjectKeyForUser(row.objectKey, row.userId, "references") ||
      !validBlobSignature("reference", row.id, row.objectKey, query.data.exp, query.data.sig)
    )
      return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      return await sendImageBlob(
        reply,
        { objectKey: row.objectKey, mime: row.mime, expiresAt: query.data.exp * 1000 },
        { signImageUrl, loadStoredImage },
      );
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });

  app.get("/api/workflow/nail-try-ons/outputs/:id/blob", async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    const query = blobQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "图片地址不合法" });
    const row = (await prisma.nailTryOnOutput.findUnique({
      where: { id: params.data.id },
    })) as unknown as NailOutputRow | null;
    if (
      !row ||
      !isNailTryOnObjectKeyForUser(row.objectKey, row.userId, "outputs") ||
      !validBlobSignature("output", row.id, row.objectKey, query.data.exp, query.data.sig)
    )
      return reply.code(404).send({ error: "图片不存在或地址已失效" });
    try {
      return await sendImageBlob(
        reply,
        {
          objectKey: row.objectKey,
          mime: row.mime,
          expiresAt: query.data.exp * 1000,
          contentDisposition: `inline; filename="nail-try-on-${row.requestIndex + 1}.png"`,
        },
        { signImageUrl, loadStoredImage },
      );
    } catch {
      return reply.code(502).send({ error: "图片加载失败" });
    }
  });
  app.post("/api/workflow/nail-try-ons/references", { preHandler: requireUser }, async (req, reply) => {
    const sharp = await loadSharp();
    const userId = req.userId;
    const parsed = nailReferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "试甲素材参数不合法" });
    const sourceBytes = Buffer.from(parsed.data.image.b64, "base64");
    if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > IMAGE_REFERENCE_MAX_BYTES)
      return reply.code(400).send({ error: "图片大小需在 10MB 以内" });
    const sourceMime = parsed.data.image.mime?.split(";", 1)[0]?.trim().toLowerCase() || "image/jpeg";
    if (!nailReferenceMimeTypes.has(sourceMime))
      return reply.code(400).send({ error: "图片仅支持 JPG、PNG、WEBP、BMP、TIFF、GIF 或 HEIC" });
    let normalized: Buffer;
    let metadata: Metadata;
    try {
      metadata = await sharp(sourceBytes, {
        limitInputPixels: NAIL_REFERENCE_MAX_PIXELS,
        animated: false,
      }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > NAIL_REFERENCE_MAX_PIXELS)
        throw new Error("invalid dimensions");
      // 手照客户端已烘焙 EXIF 方向并合成到目标档位，这里 rotate() 是幂等的，resize 内切 4096
      // 对 ≤2K 档位是 no-op，因此手照尺寸原样保留，才能和同尺寸蒙版对齐（footgun #1）。
      normalized = await sharp(sourceBytes, { limitInputPixels: NAIL_REFERENCE_MAX_PIXELS, animated: false })
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
    const requestId = `nail-try-on-reference-${randomUUID()}`;
    let stored: StoredImage;
    try {
      stored = await storeImage({
        image: { kind: "b64", b64: normalized.toString("base64"), mime: "image/jpeg" },
        userId,
        requestId,
        requestIndex: 0,
        fetchFn,
        namespace: "workflow/nail-try-ons/references",
        acl: "private",
      });
    } catch {
      return reply.code(502).send({ error: "试甲素材存储失败" });
    }
    if (!stored.objectKey || !isNailTryOnObjectKeyForUser(stored.objectKey, userId, "references"))
      return reply.code(502).send({ error: "试甲素材存储位置不合法" });
    const row = (await prisma.nailTryOnReferenceAsset.create({
      data: {
        userId,
        kind: parsed.data.kind,
        objectKey: stored.objectKey,
        mime: "image/jpeg",
        width: normalizedMetadata.width ?? metadata.width!,
        height: normalizedMetadata.height ?? metadata.height!,
        sizeBytes: normalized.byteLength,
        expiresAt: nowPlus(NAIL_REFERENCE_TTL_MS),
      },
    })) as unknown as NailReferenceRow;
    return { success: true, data: { asset: serializeReference(row) } };
  });
  app.delete("/api/workflow/nail-try-ons/references/:id", { preHandler: requireUser }, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "试甲素材参数不合法" });
    const row = (await prisma.nailTryOnReferenceAsset.findFirst({
      where: { id: params.data.id, userId: req.userId, deletedAt: null },
    })) as unknown as NailReferenceRow | null;
    if (!row) return reply.code(404).send({ error: "试甲素材不存在" });
    const active = await prisma.nailTryOnTask.findFirst({
      where: {
        userId: req.userId,
        status: { in: [...NAIL_ACTIVE_STATUSES] },
        OR: [{ handAssetId: row.id }, { nailDesignAssetId: row.id }],
      },
      select: { id: true },
    });
    if (active) return reply.code(409).send({ error: "任务生成中，暂不能删除素材" });
    await deleteStoredImage(row.objectKey).catch(() => undefined);
    await prisma.nailTryOnReferenceAsset.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), expiresAt: null },
    });
    return { success: true };
  });

  app.get("/api/workflow/nail-try-ons/state", { preHandler: requireUser }, async (req) => {
    const active = (await prisma.nailTryOnTask.findMany({
      where: { userId: req.userId, status: { in: [...NAIL_ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" },
      take: 50,
    })) as unknown as NailTaskRow[];
    // 决定 A：超时且不在本进程跑的任务当场收尸，其余照常 recover。
    const staleThreshold = Date.now() - portraitTaskStaleMs();
    const stale = active.filter(
      (task) => !activeTasks.has(task.requestId) && task.updatedAt.getTime() < staleThreshold,
    );
    const staleIds = new Set(stale.map((task) => task.id));
    await recover(active.filter((task) => !staleIds.has(task.id)));
    for (const task of stale) await failStale(task);
    const [referenceRows, tasks] = await Promise.all([
      prisma.nailTryOnReferenceAsset.findMany({
        where: { userId: req.userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.nailTryOnTask.findMany({
        where: { userId: req.userId },
        include: { outputs: { orderBy: { requestIndex: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: NAIL_TASK_KEEP_LIMIT,
      }),
    ]);
    return {
      success: true,
      data: {
        references: (referenceRows as unknown as NailReferenceRow[]).map(serializeReference),
        tasks: (tasks as unknown as NailTaskRow[]).map(serializeTask),
      },
    };
  });
  app.post("/api/workflow/nail-try-ons/generate", { preHandler: requireUser }, async (req, reply) => {
    const parsed = nailRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "试甲生成参数不完整；必须确认手部照片使用授权" });
    if (!humanImageModelSupports(parsed.data.model, parsed.data.resolution)) {
      const model = HUMAN_IMAGE_MODELS.find((item) => item.value === parsed.data.model)!;
      return reply.code(400).send({ error: `${model.label} 暂不支持 ${parsed.data.resolution}` });
    }
    const existing = await taskWithOutputs(prisma, req.userId, parsed.data.requestId);
    if (existing)
      return reply
        .code(NAIL_TERMINAL_STATUSES.has(existing.status) ? 200 : 202)
        .send({ success: true, data: { task: serializeTask(existing) } });
    const crossUser = await prisma.nailTryOnTask.findUnique({
      where: { requestId: parsed.data.requestId },
      select: { id: true },
    });
    if (crossUser) return reply.code(409).send({ error: "请求编号已被使用" });
    const roleInput = {
      handAssetId: parsed.data.handAssetId,
      nailDesignAssetId: parsed.data.nailDesignAssetId ?? null,
    };
    const references = await loadRoleReferences(prisma, req.userId, roleInput).catch(() => null);
    if (!references) return reply.code(404).send({ error: "试甲素材不存在、类型不匹配或无权访问" });
    const handRef = references[0]!;
    // 蒙版必须逐像素对齐手部照片（footgun #1）：期望尺寸 = 手照档位 = 蒙版尺寸。
    const expected = parseSize(humanImageOutputSize(parsed.data.resolution, parsed.data.aspectRatio));
    if (!expected || handRef.width !== expected.width || handRef.height !== expected.height)
      return reply.code(409).send({ error: "手部照片尺寸与所选比例不一致，请按当前比例重新上传手部照片" });
    const maskBytes = Buffer.from(parsed.data.mask.b64, "base64");
    if (maskBytes.byteLength === 0 || maskBytes.byteLength > IMAGE_REFERENCE_MAX_BYTES)
      return reply.code(400).send({ error: "蒙版大小需在 10MB 以内" });
    try {
      const sharp = await loadSharp();
      const maskMeta = await sharp(maskBytes, { limitInputPixels: NAIL_REFERENCE_MAX_PIXELS, animated: false }).metadata();
      // 蒙版必须无损 PNG（保 alpha 与硬边缘），且尺寸与手照逐像素一致，否则 openai edits 会错位。
      if (maskMeta.format !== "png" || !maskMeta.hasAlpha || maskMeta.width !== expected.width || maskMeta.height !== expected.height)
        return reply.code(400).send({ error: "蒙版与手部照片尺寸不一致或格式错误，请重新框选指甲" });
    } catch {
      return reply.code(400).send({ error: "蒙版不可读取，请重新框选指甲" });
    }
    let maskStored: StoredImage;
    try {
      maskStored = await storeImage({
        image: { kind: "b64", b64: maskBytes.toString("base64"), mime: "image/png" },
        userId: req.userId,
        requestId: parsed.data.requestId,
        requestIndex: 0,
        fetchFn,
        namespace: "workflow/nail-try-ons/masks",
        acl: "private",
      });
    } catch {
      return reply.code(502).send({ error: "蒙版存储失败" });
    }
    if (!maskStored.objectKey || !isNailTryOnObjectKeyForUser(maskStored.objectKey, req.userId, "masks"))
      return reply.code(502).send({ error: "蒙版存储位置不合法" });
    const maskObjectKey = maskStored.objectKey;
    const effectivePrompt = buildNailTryOnPrompt({
      hasDesignReference: Boolean(parsed.data.nailDesignAssetId),
      description: parsed.data.description,
    });
    const resourceKey = resolveImageChargeRow(await listPriceRows(), {
      resolution: parsed.data.resolution,
      model: parsed.data.model,
    }).resourceKey;
    const billingOperationId = `nail-try-on:${parsed.data.requestId}`;
    let task: NailTaskRow | null = null;
    let reserved = false;
    try {
      task = (await prisma.nailTryOnTask.create({
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
          maskObjectKey,
          status: "pending",
          consentVersion: NAIL_TRY_ON_CONSENT_VERSION,
          billingOperationId,
          billingResourceKey: resourceKey,
          billingReservedUnits: 0,
          billingSettledUnits: 0,
          billingStatus: "pending",
        },
        include: { outputs: true },
      })) as unknown as NailTaskRow;
      await billing.reserveResource({
        operationId: billingOperationId,
        userId: req.userId,
        resourceKey,
        units: parsed.data.count,
        reservationTtlSeconds: portraitReservationTtlSeconds(parsed.data.count),
      });
      reserved = true;
      task = (await prisma.nailTryOnTask.update({
        where: { id: task.id },
        data: { status: "running", billingReservedUnits: parsed.data.count, billingStatus: "reserved" },
        include: { outputs: true },
      })) as unknown as NailTaskRow;
    } catch (error) {
      if (reserved) await billing.refundResource(billingOperationId).catch(() => undefined);
      if (task?.id) await prisma.nailTryOnTask.delete({ where: { id: task.id } }).catch(() => undefined);
      // 任务没建成，刚存的蒙版就是孤儿，best-effort 删掉；重复请求的赢家有它自己的蒙版，不受影响。
      await deleteStoredImage(maskObjectKey).catch(() => undefined);
      const duplicate = await taskWithOutputs(prisma, req.userId, parsed.data.requestId).catch(() => null);
      if (duplicate) return reply.code(202).send({ success: true, data: { task: serializeTask(duplicate) } });
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "余额不足，请充值" });
      return reply.code(502).send({ error: "美甲试戴任务创建失败" });
    }
    schedule(task!);
    return reply.code(202).send({ success: true, data: { task: serializeTask(task!) } });
  });
  app.post("/api/workflow/nail-try-ons/tasks/:requestId/cancel", { preHandler: requireUser }, async (req, reply) => {
    const params = requestParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await taskWithOutputs(prisma, req.userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (NAIL_TERMINAL_STATUSES.has(task.status)) return { success: true, data: { task: serializeTask(task) } };
    const updated = (await prisma.nailTryOnTask.update({
      where: { id: task.id },
      data: { status: "cancelled", cancelRequested: true, completedAt: new Date(), error: "用户已取消" },
      include: { outputs: true },
    })) as unknown as NailTaskRow;
    activeTasks.get(task.requestId)?.abort();
    await settleBilling(prisma, billing, updated, updated.completedCount).catch(() => undefined);
    await markReferencesForCleanup(prisma, referenceIds(task)).catch(() => undefined);
    return {
      success: true,
      data: { task: serializeTask((await taskWithOutputs(prisma, req.userId, task.requestId))!) },
    };
  });

  app.delete("/api/workflow/nail-try-ons/tasks/:requestId", { preHandler: requireUser }, async (req, reply) => {
    const params = requestParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "任务编号不合法" });
    const task = await taskWithOutputs(prisma, req.userId, params.data.requestId);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (!NAIL_TERMINAL_STATUSES.has(task.status))
      return reply.code(409).send({ error: "任务仍在生成中，暂不能删除" });
    for (const output of task.outputs ?? []) await deleteStoredImage(output.objectKey).catch(() => undefined);
    // 试甲台任务独有蒙版对象，一并回收，别把无损 PNG 蒙版留在私有桶里。
    if (task.maskObjectKey) await deleteStoredImage(task.maskObjectKey).catch(() => undefined);
    await prisma.nailTryOnTask.delete({ where: { id: task.id } });
    return { success: true };
  });
}

export { cleanupExpiredReferences };
