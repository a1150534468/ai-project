import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { z } from "zod";
import { getPrisma } from "@ai-assistant/db";
import { createBillingClient, InsufficientBalanceError } from "@ai-assistant/billing";
import { optimizeVideoPrompt } from "./video-prompt-optimize.js";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import type Anthropic from "@anthropic-ai/sdk";
import { analyzeMaterials, analyzeReference } from "../_shared/video-analyze-service.js";
import { generateScript, type ScriptPayload } from "./video-script-service.js";
import { probeVideoDurationSec } from "../_shared/video-probe.js";
import {
  AUDIO_REFERENCE_ROLE,
  VIDEO_ASPECT_RATIOS,
  VIDEO_IMAGE_ROLES,
  VIDEO_MODELS,
  VIDEO_PRICE_CONFIGS,
  VIDEO_REFERENCE_ROLE,
  VIDEO_RESOLUTIONS,
  getVideoGenerationStatus,
  isAutoDuration,
  isDurationSupported,
  isResolutionSupported,
  loadVideoGenerationConfig,
  MAX_VIDEO_DURATION_SEC,
  probeVideoGenerationStatus,
  storeGeneratedVideo,
  storeVideoMaterial,
  submitVideoGeneration,
  videoGenerationResourceKey,
  VIDEO_ANALYZE_IMAGE_RESOURCE_KEY,
  VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY,
  type ExtractedVideoStatus,
  type VideoAspectRatio,
  type VideoImageRole,
  type VideoModel,
  type VideoResolution,
  type VideoRoleInput,
  type VideoTaskStatus,
} from "../_shared/video-service.js";
import { startVideoReaper, type VideoReapHandlers } from "./video-reaper.js";
import { VIDEO_TASK_STATUS, videoOperationId, type VideoTaskRow } from "./video-shared.js";

const VIDEO_KEEP_LIMIT = 30;
const VIDEO_TASK_KEEP_LIMIT = 20;
const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INITIAL_DELAY_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;

/** 从 video-shared.ts 搬来（reaper 也要用，放共享文件破循环导入）。别名保留，免得这一整个文件都要改。 */
const videoTaskStatus = VIDEO_TASK_STATUS;

const imageRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.enum(VIDEO_IMAGE_ROLES),
});

const videoRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.literal(VIDEO_REFERENCE_ROLE),
});

const audioRoleSchema = z.object({
  url: z.string().trim().min(1).max(8000),
  role: z.literal(AUDIO_REFERENCE_ROLE),
});

const videoRequestSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  prompt: z.string().trim().min(1).max(2000),
  model: z.enum(VIDEO_MODELS).default("seedance-2"),
  durationSec: z.number().int().gte(-1).lte(15),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(VIDEO_RESOLUTIONS).default("720p"),
  generateAudio: z.boolean().default(true),
  imageWithRoles: z.array(imageRoleSchema).max(9).default([]),
  videoWithRoles: z.array(videoRoleSchema).max(3).default([]),
  audioWithRoles: z.array(audioRoleSchema).max(3).default([]),
  seed: z.number().int().optional(),
}).superRefine((value, ctx) => {
  if (!isResolutionSupported(value.model, value.resolution)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "该模型不支持所选分辨率", path: ["resolution"] });
  }
  if (!isDurationSupported(value.model, value.durationSec)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "该模型不支持所选时长", path: ["durationSec"] });
  }
  if (value.model === "seedance-2-mini" && value.imageWithRoles.some((item) => item.role !== "reference_image")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mini 模型只支持参考图", path: ["imageWithRoles"] });
  }
  const hasFrameMode = value.imageWithRoles.some((item) => item.role === "first_frame" || item.role === "last_frame");
  const hasReferenceMode = value.imageWithRoles.some((item) => item.role === "reference_image") || value.videoWithRoles.length > 0 || value.audioWithRoles.length > 0;
  if (hasFrameMode && hasReferenceMode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "首帧/首尾帧模式不能和参考素材模式混用", path: ["imageWithRoles"] });
  }
  if (value.audioWithRoles.length > 0 && value.imageWithRoles.length === 0 && value.videoWithRoles.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "音频参考不能单独使用", path: ["audioWithRoles"] });
  }
  if (value.imageWithRoles.filter((item) => item.role === "first_frame").length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "首帧图最多 1 张", path: ["imageWithRoles"] });
  }
  if (value.imageWithRoles.filter((item) => item.role === "last_frame").length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "尾帧图最多 1 张", path: ["imageWithRoles"] });
  }
});

type VideoGenerationRequest = z.infer<typeof videoRequestSchema>;

const optimizePromptSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  materials: z.object({
    image: z.number().int().min(0).max(9).default(0),
    video: z.number().int().min(0).max(3).default(0),
    audio: z.number().int().min(0).max(3).default(0),
  }).optional(),
});

// —— 帮我写向导 schemas ——
const analyzeMaterialsSchema = z.object({
  requestId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  materials: z.array(z.object({ url: z.string().trim().min(1).max(8000), mime: z.string().trim().min(1).max(100) })).min(1).max(15),
});
const insightObjSchema = z.object({
  productName: z.string().max(200).default(""),
  category: z.string().max(200).default(""),
  features: z.array(z.string().max(200)).max(20).default([]),
  sellingPoints: z.array(z.string().max(200)).max(20).default([]),
  audience: z.array(z.string().max(200)).max(20).default([]),
  scenes: z.array(z.string().max(200)).max(20).default([]),
});
const generateScriptSchema = z.object({
  insight: insightObjSchema,
  business: z.string().max(50),
  language: z.string().max(50),
  contentType: z.string().max(50),
  shootType: z.string().max(50),
  note: z.string().max(2000).default(""),
  durationSec: z.number().int().gte(1).lte(15),
  hasNarration: z.boolean().optional(),
  materials: z.object({
    image: z.number().int().min(0).max(9),
    video: z.number().int().min(0).max(3),
    audio: z.number().int().min(0).max(3),
  }).optional(),
  reference: z.object({ script: z.string().max(20000), highlights: z.array(z.string().max(500)).max(20) }).optional(),
});

interface BillingResourcePrice {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly outputRate?: number;
  readonly perUnits: number;
  readonly enabled: boolean;
}

interface BillingForVideos {
  chargeResource: (args: { operationId: string; userId: string; resourceKey: string; units: number; inputUnits?: number; accountType?: "points" | "video" }) => Promise<{ charged: number }>;
  settleVideoResource?: (args: { operationId: string; resourceKey: string; units: number; inputUnits?: number }) => Promise<{ settled: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
  listResourcePrices?: () => Promise<{ data: BillingResourcePrice[] }>;
  // 脚本生成走 token 计费（原价×2 在服务层实现）
  reserve: (args: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (args: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<{ settled: number }>;
}

type ScheduleTask = (work: () => Promise<void>) => void;

interface VideoWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: BillingForVideos;
  readonly fetchFn?: typeof fetch;
  readonly scheduleTask?: ScheduleTask;
  readonly pollInitialDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
  readonly submitRetries?: number;
  readonly submitRetryDelayMs?: number;
  readonly llmClient?: Anthropic;
  // 视频/图片理解已切到 gemini 原生 vision（见 vision-client.ts）；测试注入用
  readonly visionCfg?: import("../_shared/vision-client.js").VisionConfig;
  readonly callVisionFn?: typeof import("../_shared/vision-client.js").callVision;
  /**
   * 给了才起主动扫的定时器。留成可选是为了让既有测试注册插件时不需要 redis，
   * 也避免测试进程里凭空多一个后台定时器。生产在 server.ts 注入。
   */
  readonly redis?: import("ioredis").Redis;
}

// 参考视频独立小限（区别于生成素材的 350MB）；UI 引导 30 秒以内。
const VIDEO_REF_MAX_BYTES = Number(process.env.VIDEO_REF_MAX_BYTES) || 50 * 1024 * 1024;

interface VideoAssetRow {
  readonly id: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly prompt: string;
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly durationSec: number;
  readonly originalUrl: string;
  readonly mime: string;
  readonly format: string;
  readonly createdAt: Date;
}

function loadNumber(envKey: string, fallback: number): number {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "视频生成失败";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_SUBMIT_RETRIES = 2;
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 2_000;

// 仅瞬态错误可重试：abort/超时/网络/5xx/429；明确 4xx（非 429）客户端错误不重试（重试也不会成功）。
function isTransientSubmitError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const matched = msg.match(/video submit (\d{3})/);
  if (matched) {
    const code = Number(matched[1]);
    if (code >= 400 && code < 500 && code !== 429) return false;
    return code >= 500 || code === 429;
  }
  return /abort|timeout|超时|fetch failed|econnreset|etimedout|socket|network|und_err/.test(msg);
}

// 提交带重试：上游偶发提交超时/抖动时自动重试。requestId 作 client_business_id 传上游，
// 上游按此幂等去重则安全；即便重复建任务，我方计费仍只扣一次、失败退款。
async function submitWithRetry(
  submitArgs: Parameters<typeof submitVideoGeneration>[0],
  retries: number,
  delayMs: number,
  onRetry?: (error: unknown, attempt: number) => void,
): Promise<Awaited<ReturnType<typeof submitVideoGeneration>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await submitVideoGeneration(submitArgs);
    } catch (error) {
      lastErr = error;
      if (attempt === retries || !isTransientSubmitError(error)) throw error;
      onRetry?.(error, attempt + 1);
      await wait(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

function hasInputVideo(request: VideoGenerationRequest): boolean {
  return request.videoWithRoles.length > 0;
}

// 汇总多个输入视频的权威时长（秒）。仅统计存在且时长 > 0 的素材；任一素材缺时长则整体视为不可计费（返回 0）。
async function sumInputDurationSec(prisma: PrismaClient, urls: readonly string[]): Promise<number> {
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) return 0;
  const rows = await prisma.videoMaterial.findMany({
    where: { url: { in: uniqueUrls } },
    select: { url: true, durationSec: true },
  });
  const durationByUrl = new Map(rows.map((row) => [row.url, row.durationSec]));
  let total = 0;
  for (const url of uniqueUrls) {
    const seconds = durationByUrl.get(url) ?? 0;
    if (seconds <= 0) return 0;
    total += seconds;
  }
  return total;
}

function normalizeRequest(data: VideoGenerationRequest) {
  return {
    requestId: data.requestId,
    model: data.model as VideoModel,
    prompt: data.prompt,
    durationSec: data.durationSec,
    aspectRatio: data.aspectRatio as VideoAspectRatio,
    resolution: data.resolution as VideoResolution,
    generateAudio: data.generateAudio,
    imageWithRoles: data.imageWithRoles as readonly VideoRoleInput<VideoImageRole>[],
    videoWithRoles: data.videoWithRoles as readonly VideoRoleInput<typeof VIDEO_REFERENCE_ROLE>[],
    audioWithRoles: data.audioWithRoles as readonly VideoRoleInput<typeof AUDIO_REFERENCE_ROLE>[],
    ...(data.seed !== undefined ? { seed: data.seed } : {}),
  };
}

function serializeVideo(row: VideoAssetRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeTask(row: VideoTaskRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    providerTaskId: row.providerTaskId,
    prompt: row.prompt,
    model: row.model,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution,
    durationSec: row.durationSec,
    generateAudio: row.generateAudio,
    hasInputVideo: row.hasInputVideo,
    resourceKey: row.resourceKey,
    chargedPoints: row.chargedPoints,
    status: row.status as VideoTaskStatus,
    progress: row.progress,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function listRecentVideos(prisma: PrismaClient, userId: string): Promise<VideoAssetRow[]> {
  return prisma.videoAsset.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: VIDEO_KEEP_LIMIT,
    select: {
      id: true,
      requestId: true,
      requestIndex: true,
      prompt: true,
      model: true,
      aspectRatio: true,
      resolution: true,
      durationSec: true,
      originalUrl: true,
      mime: true,
      format: true,
      createdAt: true,
    },
  });
}

async function listRecentTasks(prisma: PrismaClient, userId: string): Promise<VideoTaskRow[]> {
  return prisma.videoGenerationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: VIDEO_TASK_KEEP_LIMIT,
  });
}

function configuredVideoPriceRows(rows: readonly BillingResourcePrice[]) {
  return VIDEO_PRICE_CONFIGS.map((config) => {
    const found = rows.find((row) => row.resourceKey === config.resourceKey);
    // 有输入视频复合计价 VIDEO_IO：rate=输入单价/秒，outputRate=输出单价/秒；无输入视频保持 PER_UNIT。
    return {
      ...config,
      displayName: found?.displayName?.trim() || config.displayName,
      pricingType: config.hasInputVideo ? ("VIDEO_IO" as const) : ("PER_UNIT" as const),
      rate: found?.rate ?? 0,
      outputRate: config.hasInputVideo ? (found?.outputRate ?? 0) : 0,
      perUnits: found?.perUnits && found.perUnits > 0 ? found.perUnits : 1,
      enabled: found?.enabled ?? false,
    };
  });
}

function roleInputsJson(inputs: readonly VideoRoleInput<string>[]): Prisma.InputJsonArray {
  return inputs.map((item) => ({ url: item.url, role: item.role }));
}

function requestPayloadJson(request: ReturnType<typeof normalizeRequest>): Prisma.InputJsonObject {
  return {
    model: request.model,
    client_business_id: request.requestId,
    prompt: request.prompt,
    duration: request.durationSec,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.model !== "seedance-2-mini" ? { generate_audio: request.generateAudio } : {}),
    ...(request.imageWithRoles.length > 0 ? { image_with_roles: roleInputsJson(request.imageWithRoles) } : {}),
    ...(request.videoWithRoles.length > 0 ? { video_with_roles: roleInputsJson(request.videoWithRoles) } : {}),
    ...(request.audioWithRoles.length > 0 ? { audio_with_roles: roleInputsJson(request.audioWithRoles) } : {}),
  };
}

function statusPayloadJson(status: ExtractedVideoStatus): Prisma.InputJsonObject {
  return {
    providerTaskId: status.providerTaskId,
    providerStatus: status.providerStatus,
    status: status.status,
    progress: status.progress,
    videoUrl: status.videoUrl,
    format: status.format,
    error: status.error,
    completedAt: status.completedAt?.toISOString() ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
  };
}

async function pollVideoUntilDone(args: {
  readonly task: VideoTaskRow;
  readonly cfg: ReturnType<typeof loadVideoGenerationConfig>;
  readonly prisma: PrismaClient;
  readonly fetchFn: typeof fetch;
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly maxAttempts: number;
}): Promise<ExtractedVideoStatus> {
  const providerTaskId = args.task.providerTaskId;
  if (!providerTaskId) throw new Error("missing provider task id");
  if (args.initialDelayMs > 0) await wait(args.initialDelayMs);
  let lastStatus: ExtractedVideoStatus | null = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const status = await getVideoGenerationStatus({
      cfg: args.cfg,
      providerTaskId,
      fetchFn: args.fetchFn,
      timeoutMs: loadNumber("VIDEO_STATUS_TIMEOUT_MS", DEFAULT_STATUS_TIMEOUT_MS),
    });
    lastStatus = status;
    // 完成态延后到视频入库后由 runVideoTask 统一写(storeGeneratedVideo→upsert asset→标记 completed)。
    // 此处若把 completed 提前落库，会出现"任务已完成但 videoAsset 尚未入库"的空窗；
    // 一旦后台任务在下载期间被中断(如 pod 滚动重启)，任务将永久停在 completed 却无视频。
    const providerCompleted = status.status === videoTaskStatus.completed;
    await args.prisma.videoGenerationTask.update({
      where: { id: args.task.id },
      data: {
        status: providerCompleted ? videoTaskStatus.running : status.status,
        progress: status.progress,
        error: status.error,
        resultPayload: statusPayloadJson(status),
        completedAt: providerCompleted ? null : status.completedAt,
      },
    });
    if (status.status === videoTaskStatus.completed || status.status === videoTaskStatus.failed) return status;
    if (attempt < args.maxAttempts) await wait(args.intervalMs);
  }
  throw new Error(`video task timeout${lastStatus ? `: ${lastStatus.providerStatus}` : ""}`);
}

/**
 * 提交之后那半段：轮询到终态 → 下载入库 → 自动时长结算 → 标记 completed。
 *
 * 从 `runVideoTask` 里抽出来，是因为兜底扫必须能对**已经拿到 `providerTaskId`**
 * 的行单独跑这半段。直接拿 `runVideoTask` 去续跑会从提交开始，向上游重复提交
 * 一个新任务（还会重复计费）。
 *
 * 不含 try/catch：失败一律往外抛，由调用方决定收尾（主路径与兜底都收敛到
 * `refundAndFailVideoTask`，语义保持一致）。
 *
 * `inputDurationSec` 传 `null` 表示「不知道」。这不是可选参数的省略 ——
 * 见下方结算处的说明，传错比不传更糟。
 */
async function finishSubmittedVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly fetchFn: typeof fetch;
  readonly task: VideoTaskRow;
  readonly cfg: ReturnType<typeof loadVideoGenerationConfig>;
  readonly pollInitialDelayMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly inputDurationSec: number | null;
  readonly onSettleSkipped?: (task: VideoTaskRow) => void;
}): Promise<void> {
  const operationId = videoOperationId(args.task.requestId);
  const task = args.task;
  const finalStatus = await pollVideoUntilDone({
    task,
    cfg: args.cfg,
    prisma: args.prisma,
    fetchFn: args.fetchFn,
    initialDelayMs: args.pollInitialDelayMs,
    intervalMs: args.pollIntervalMs,
    maxAttempts: args.maxPollAttempts,
  });
  if (finalStatus.status === videoTaskStatus.failed) throw new Error(finalStatus.error ?? "视频生成失败");
  if (!finalStatus.videoUrl) throw new Error("视频生成结果缺少 URL");
  const stored = await storeGeneratedVideo({
    url: finalStatus.videoUrl,
    userId: task.userId,
    requestId: task.requestId,
    requestIndex: 0,
    format: finalStatus.format,
    fetchFn: args.fetchFn,
  });
  // 自动时长：按实际输出秒结算，退回预扣（15s）多扣的差额。best-effort：结算失败不回滚已生成的视频。
  //
  // 有输入视频而又不知道输入秒数时**必须跳过**，不能拿 0 顶上：结算侧
  // `SettleVideoIO` 会用 `QuoteVideoIO(resourceKey, inputSec, outputSec)` 重算实际成本，
  // 对 VIDEO_IO 定价是 `输入秒×输入单价 + 输出秒×输出单价`（billing 的
  // resource.go:88）。inputSec 传 0 会把实际成本算少，于是**多退**给用户一笔。
  // 跳过只是让用户按预扣的 15s 多付一点，方向上安全得多。
  const inputUnitsUnknown = task.hasInputVideo && args.inputDurationSec === null;
  if (isAutoDuration(task.durationSec) && stored.durationSec > 0 && args.billing.settleVideoResource) {
    if (inputUnitsUnknown) args.onSettleSkipped?.(task);
    else {
      await args.billing.settleVideoResource({
        operationId,
        resourceKey: task.resourceKey,
        units: stored.durationSec,
        ...(task.hasInputVideo ? { inputUnits: args.inputDurationSec as number } : {}),
      }).catch(() => undefined);
    }
  }
  const assetDurationSec = stored.durationSec > 0 ? stored.durationSec : task.durationSec;
  await args.prisma.videoAsset.upsert({
    where: { requestId_requestIndex: { requestId: task.requestId, requestIndex: 0 } },
    update: {},
    create: {
      userId: task.userId,
      requestId: task.requestId,
      requestIndex: 0,
      prompt: task.prompt,
      model: task.model,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
      durationSec: assetDurationSec,
      originalUrl: stored.originalUrl,
      objectKey: stored.objectKey,
      mime: stored.mime,
      format: stored.format,
    },
  });
  await args.prisma.videoGenerationTask.update({
    where: { id: task.id },
    data: {
      status: videoTaskStatus.completed,
      progress: 100,
      error: null,
      completedAt: finalStatus.completedAt ?? new Date(),
      resultPayload: statusPayloadJson(finalStatus),
    },
  });
}

/** 退款 + 置 failed。主路径与兜底扫共用，保证两边的失败语义一字不差。 */
async function refundAndFailVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly task: VideoTaskRow;
  readonly error: unknown;
}): Promise<void> {
  await args.billing.refundResource(videoOperationId(args.task.requestId)).catch(() => undefined);
  await args.prisma.videoGenerationTask.update({
    where: { id: args.task.id },
    data: {
      status: videoTaskStatus.failed,
      error: safeErrorMessage(args.error),
    },
  }).catch(() => undefined);
}

async function runVideoTask(args: {
  readonly prisma: PrismaClient;
  readonly billing: BillingForVideos;
  readonly fetchFn: typeof fetch;
  readonly task: VideoTaskRow;
  readonly request: ReturnType<typeof normalizeRequest>;
  readonly pollInitialDelayMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly inputDurationSec: number;
  readonly submitRetries: number;
  readonly submitRetryDelayMs: number;
  readonly onSubmitRetry?: (error: unknown, attempt: number) => void;
}): Promise<void> {
  try {
    const cfg = loadVideoGenerationConfig();
    const submitted = await submitWithRetry({
      cfg,
      request: args.request,
      fetchFn: args.fetchFn,
      timeoutMs: loadNumber("VIDEO_SUBMIT_TIMEOUT_MS", DEFAULT_SUBMIT_TIMEOUT_MS),
    }, args.submitRetries, args.submitRetryDelayMs, args.onSubmitRetry);
    const task = await args.prisma.videoGenerationTask.update({
      where: { id: args.task.id },
      data: {
        providerTaskId: submitted.providerTaskId,
        status: submitted.status,
        progress: submitted.progress,
        error: null,
      },
    });
    await finishSubmittedVideoTask({
      prisma: args.prisma,
      billing: args.billing,
      fetchFn: args.fetchFn,
      task,
      cfg,
      pollInitialDelayMs: args.pollInitialDelayMs,
      pollIntervalMs: args.pollIntervalMs,
      maxPollAttempts: args.maxPollAttempts,
      inputDurationSec: args.inputDurationSec,
    });
  } catch (error) {
    await refundAndFailVideoTask({ prisma: args.prisma, billing: args.billing, task: args.task, error });
    throw error;
  }
}

export async function videoWorkflowRoutes(app: FastifyInstance, deps: VideoWorkflowRouteDeps = {}) {
  // 本文件 11 个路由全部必须登录，挂插件级。钩子和它保护的路由同文件，
  // 这样测试单独注册本文件时守卫不会凭空消失。
  app.addHook("preHandler", requireUser);

  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const fetchFn = deps.fetchFn ?? fetch;
  const scheduleTask = deps.scheduleTask ?? ((work: () => Promise<void>) => {
    void work().catch((error) => app.log.error(error));
  });
  const pollInitialDelayMs = deps.pollInitialDelayMs ?? loadNumber("VIDEO_POLL_INITIAL_DELAY_MS", DEFAULT_POLL_INITIAL_DELAY_MS);
  const pollIntervalMs = deps.pollIntervalMs ?? loadNumber("VIDEO_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
  const maxPollAttempts = deps.maxPollAttempts ?? loadNumber("VIDEO_MAX_POLL_ATTEMPTS", DEFAULT_MAX_POLL_ATTEMPTS);
  const submitRetries = deps.submitRetries ?? loadNumber("VIDEO_SUBMIT_RETRIES", DEFAULT_SUBMIT_RETRIES);
  const submitRetryDelayMs = deps.submitRetryDelayMs ?? loadNumber("VIDEO_SUBMIT_RETRY_DELAY_MS", DEFAULT_SUBMIT_RETRY_DELAY_MS);
  // 懒构造：仅在帮我写路由真正被调用时才读 LLM 配置，避免无关路由/测试因缺 LLM_* env 而在注册期报错。
  let llmClientCache: Anthropic | null = deps.llmClient ?? null;
  const getLlmClient = (): Anthropic => {
    if (!llmClientCache) llmClientCache = createLlmClient(loadLlmConfig());
    return llmClientCache;
  };

  // —— 主动扫（超时兜底）——
  // 之前 video 一个兜底都没有：进程被杀，行就永久停在 running，钱也永久悬空。
  // 注册在插件内而非 server.ts，因为续跑要用这里的 fetchFn / billing / 轮询参数。
  const reapHandlers: VideoReapHandlers = {
    probe: async (row) => {
      const probed = await probeVideoGenerationStatus({
        cfg: loadVideoGenerationConfig(),
        providerTaskId: row.providerTaskId,
        fetchFn,
        timeoutMs: loadNumber("VIDEO_STATUS_TIMEOUT_MS", DEFAULT_STATUS_TIMEOUT_MS),
      });
      if (probed.kind === "found") {
        return { kind: "found", upstreamFailed: probed.status.status === videoTaskStatus.failed };
      }
      return probed.kind === "missing" ? { kind: "missing" } : { kind: "unknown", reason: probed.reason };
    },
    resume: async (row) => {
      try {
        await finishSubmittedVideoTask({
          prisma,
          billing,
          fetchFn,
          task: row,
          cfg: loadVideoGenerationConfig(),
          // 续跑时不再等首次延迟：这一行早就提交出去了，没必要再空等 5 秒。
          pollInitialDelayMs: 0,
          pollIntervalMs,
          maxPollAttempts,
          // 兜底扫拿不到输入视频秒数：建行时写进 resultPayload 的请求体已被首次轮询
          // 覆盖成状态体。传 null 让结算那步跳过而不是拿 0 顶上（拿 0 会多退钱）。
          inputDurationSec: null,
          onSettleSkipped: (task) => app.log.warn(
            { requestId: task.requestId },
            "video reaper resumed a task with input video; skipped auto-duration settle (input seconds unknown)",
          ),
        });
      } catch (error) {
        // 续跑失败 → 与主路径同一套收尾：退款 + 置 failed。
        await refundAndFailVideoTask({ prisma, billing, task: row, error });
        throw error;
      }
    },
    fail: async (row, reason) => {
      await refundAndFailVideoTask({ prisma, billing, task: row, error: new Error(reason) });
    },
    onOutcome: (row, outcome, detail) => {
      if (outcome === "resumed" || outcome === "failed") {
        app.log.warn({ requestId: row.requestId, outcome, detail }, "video reaper handled a stale task");
      }
    },
  };

  if (deps.redis) {
    const timer = startVideoReaper({
      prisma,
      redis: deps.redis,
      handlers: reapHandlers,
      onError: (error) => app.log.error({ err: error }, "video reaper tick failed"),
    });
    // 必须清：插件可以被反复注册（测试、多实例 fastify），漏了就攒定时器。
    app.addHook("onClose", async () => { clearInterval(timer); });
  }

  app.get("/api/workflow/videos/pricing", async (req, reply) => {
    const userId = req.userId;
    if (!billing.listResourcePrices) return { success: true, data: configuredVideoPriceRows([]) };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      return { success: true, data: configuredVideoPriceRows(rows) };
    } catch (error) {
      app.log.warn({ err: error }, "load video pricing failed");
      return reply.code(502).send({ error: "获取视频价格失败" });
    }
  });

  // 帮我写「拆解」价：图片按张 + 视频按秒。供向导预估消耗与判断价格是否已配置。
  app.get("/api/workflow/videos/analyze-pricing", async (req, reply) => {
    const userId = req.userId;
    const empty = { rate: 0, perUnits: 1, enabled: false };
    if (!billing.listResourcePrices) return { success: true, data: { image: empty, videoSec: empty } };
    try {
      const rows = (await billing.listResourcePrices()).data ?? [];
      const pick = (key: string) => {
        const row = rows.find((r) => r.resourceKey === key);
        return { rate: row?.rate ?? 0, perUnits: row?.perUnits && row.perUnits > 0 ? row.perUnits : 1, enabled: row?.enabled ?? false };
      };
      return { success: true, data: { image: pick(VIDEO_ANALYZE_IMAGE_RESOURCE_KEY), videoSec: pick(VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY) } };
    } catch (error) {
      app.log.warn({ err: error }, "load analyze pricing failed");
      return reply.code(502).send({ error: "获取拆解价格失败" });
    }
  });

  app.post("/api/workflow/videos/optimize-prompt", async (req, reply) => {
    const userId = req.userId;
    const parsed = optimizePromptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const optimized = await optimizeVideoPrompt({ prompt: parsed.data.prompt, userId, materials: parsed.data.materials });
      return { success: true, data: { optimized } };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "算力点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      app.log.warn({ err: error }, "optimize video prompt failed");
      return reply.code(502).send({ error: "提示词优化失败，请稍后再试" });
    }
  });

  app.get("/api/workflow/videos", async (req, reply) => {
    const userId = req.userId;
    const rows = await listRecentVideos(prisma, userId);
    return { success: true, data: rows.map(serializeVideo) };
  });

  // —— 帮我写：素材分析（图片按张 + 视频按秒计费）——
  app.post("/api/workflow/videos/analyze-materials", async (req, reply) => {
    const userId = req.userId;
    const parsed = analyzeMaterialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const insight = await analyzeMaterials({
        userId,
        requestId: parsed.data.requestId,
        materials: parsed.data.materials,
        billing,
        ...(deps.visionCfg ? { cfg: deps.visionCfg } : {}),
        ...(deps.callVisionFn ? { callVisionFn: deps.callVisionFn } : {}),
        resolveVideoSeconds: async (urls) => {
          const rows = await prisma.videoMaterial.findMany({
            where: { url: { in: [...new Set(urls)] } },
            select: { url: true, durationSec: true },
          });
          return new Map(rows.map((r) => [r.url, r.durationSec]));
        },
        fetchFn,
      });
      return { success: true, data: insight };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "analyze materials failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  // —— 帮我写：参考视频拆解（≤50MB，按秒计费）——
  app.post("/api/workflow/videos/analyze-reference", async (req, reply) => {
    const userId = req.userId;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择参考视频" });
    if (!file.mimetype.startsWith("video/")) return reply.code(400).send({ error: "仅支持视频文件" });
    const buffer = Buffer.from(await file.toBuffer());
    if (buffer.byteLength > VIDEO_REF_MAX_BYTES) return reply.code(400).send({ error: "参考视频不能超过 50MB" });
    try {
      const durationSec = await probeVideoDurationSec(buffer);
      const result = await analyzeReference({
        userId,
        // randomUUID 保证 operationId 全局唯一，避免多用户同毫秒上传导致的计费冲突
        requestId: `ref-${userId}-${randomUUID()}`,
        videoBuffer: buffer,
        mime: file.mimetype,
        durationSec,
        billing,
        ...(deps.visionCfg ? { cfg: deps.visionCfg } : {}),
        ...(deps.callVisionFn ? { callVisionFn: deps.callVisionFn } : {}),
      });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "analyze reference failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  // —— 帮我写：脚本生成（token 原价×2 计费）——
  app.post("/api/workflow/videos/generate-script", async (req, reply) => {
    const userId = req.userId;
    const parsed = generateScriptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    try {
      const result = await generateScript({ userId, payload: parsed.data as ScriptPayload, client: getLlmClient(), billing });
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof InsufficientBalanceError) return reply.code(402).send({ error: "算力点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      app.log.warn({ err: error }, "generate script failed");
      return reply.code(502).send({ error: safeErrorMessage(error) });
    }
  });

  app.get("/api/workflow/videos/tasks", async (req, reply) => {
    const userId = req.userId;
    const rows = await listRecentTasks(prisma, userId);
    return { success: true, data: rows.map(serializeTask) };
  });

  app.get("/api/workflow/videos/state", async (req, reply) => {
    const userId = req.userId;
    const [videos, tasks] = await Promise.all([
      listRecentVideos(prisma, userId),
      listRecentTasks(prisma, userId),
    ]);
    return {
      success: true,
      data: {
        videos: videos.map(serializeVideo),
        tasks: tasks.map(serializeTask),
      },
    };
  });

  app.post("/api/workflow/videos/materials", async (req, reply) => {
    const userId = req.userId;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "请选择素材文件" });
    const buffer = Buffer.from(await file.toBuffer());
    try {
      const stored = await storeVideoMaterial({
        userId,
        filename: file.filename,
        mime: file.mimetype,
        buffer,
      });
      // 缓存权威时长（按 URL 键），供「有输入视频」复合计费按输入时长扣费。
      if (stored.mime.startsWith("video/")) {
        await prisma.videoMaterial.upsert({
          where: { url: stored.url },
          update: { durationSec: stored.durationSec, objectKey: stored.objectKey, mime: stored.mime },
          create: {
            userId,
            url: stored.url,
            objectKey: stored.objectKey,
            mime: stored.mime,
            durationSec: stored.durationSec,
          },
        });
      }
      return { success: true, data: stored };
    } catch (error) {
      return reply.code(400).send({ error: safeErrorMessage(error) });
    }
  });

  app.post("/api/workflow/videos/generate", async (req, reply) => {
    const userId = req.userId;
    const parsed = videoRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数不合法" });
    const request = normalizeRequest(parsed.data);
    const inputVideo = hasInputVideo(parsed.data);
    const resourceKey = videoGenerationResourceKey(request.model, request.resolution, inputVideo);
    const operationId = videoOperationId(request.requestId);

    const existingTask = await prisma.videoGenerationTask.findFirst({
      where: { userId, requestId: request.requestId },
    });
    if (existingTask) {
      const videos = await listRecentVideos(prisma, userId);
      return reply.code(existingTask.status === videoTaskStatus.completed ? 200 : 202).send({
        success: true,
        data: {
          task: serializeTask(existingTask),
          videos: videos.map(serializeVideo),
        },
      });
    }

    // 有输入视频时按复合计费：输入视频秒数 × 输入单价 + 输出秒数 × 输出单价。
    // 输入时长为计费依据，必须取后端上传时 ffprobe 落库的权威值，不可信客户端。
    let inputDurationSec = 0;
    if (inputVideo) {
      inputDurationSec = await sumInputDurationSec(prisma, parsed.data.videoWithRoles.map((item) => item.url));
      if (inputDurationSec <= 0) {
        return reply.code(400).send({ error: "无法获取输入视频时长，请通过上传素材接口重新上传输入视频" });
      }
    }

    // 自动时长（0/-1）：下单不知实际输出秒，先按最大 15s 预扣，出结果后按实际秒结算退差额。
    const autoDuration = isAutoDuration(request.durationSec);
    const chargeOutputUnits = autoDuration ? MAX_VIDEO_DURATION_SEC : request.durationSec;

    let chargedPoints = 0;
    try {
      const charged = await billing.chargeResource({
        operationId,
        userId,
        resourceKey,
        units: chargeOutputUnits,
        ...(inputVideo ? { inputUnits: inputDurationSec } : {}),
        accountType: "video",
      });
      chargedPoints = charged.charged;
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return reply.code(402).send({ error: "视频点不足，请充值", code: "INSUFFICIENT_BALANCE" });
      }
      return reply.code(502).send({ error: "视频计费未配置或服务不可用" });
    }

    let task: VideoTaskRow;
    try {
      task = await prisma.videoGenerationTask.create({
        data: {
          userId,
          requestId: request.requestId,
          providerTaskId: null,
          prompt: request.prompt,
          model: request.model,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          durationSec: request.durationSec,
          generateAudio: request.generateAudio,
          hasInputVideo: inputVideo,
          resourceKey,
          chargedPoints,
          status: videoTaskStatus.running,
          progress: 0,
          error: null,
          resultPayload: requestPayloadJson(request),
          completedAt: null,
        },
      });
    } catch (error) {
      await billing.refundResource(operationId).catch(() => undefined);
      app.log.error(error);
      return reply.code(500).send({ error: "创建视频任务失败" });
    }

    scheduleTask(async () => {
      await runVideoTask({
        prisma,
        billing,
        fetchFn,
        task,
        request,
        pollInitialDelayMs,
        pollIntervalMs,
        maxPollAttempts,
        inputDurationSec,
        submitRetries,
        submitRetryDelayMs,
        onSubmitRetry: (err, attempt) => app.log.warn({ err, attempt, requestId: request.requestId }, "video submit retry"),
      });
    });

    const videos = await listRecentVideos(prisma, userId);
    return reply.code(202).send({
      success: true,
      data: {
        task: serializeTask(task),
        videos: videos.map(serializeVideo),
      },
    });
  });
}
