import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadS3Config, makeS3, putObject, putObjectFile, type S3Config } from "../storage/s3.js";
import { probeVideoDurationSec, probeVideoDurationSecFromFile } from "./video-probe.js";
import { loadWorkflowMediaFile } from "./_shared/workflow-media-loader.js";

export const VIDEO_MODELS = ["seedance-2", "seedance-2-fast", "seedance-2-mini"] as const;
export const VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export const VIDEO_IMAGE_ROLES = ["first_frame", "last_frame", "reference_image"] as const;
export const VIDEO_REFERENCE_ROLE = "reference_video";
export const AUDIO_REFERENCE_ROLE = "reference_audio";

export type VideoModel = typeof VIDEO_MODELS[number];
export type VideoAspectRatio = typeof VIDEO_ASPECT_RATIOS[number];
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number];
export type VideoImageRole = typeof VIDEO_IMAGE_ROLES[number];

export interface VideoPriceConfig {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly model: VideoModel;
  readonly resolution: VideoResolution;
  readonly hasInputVideo: boolean;
}

export interface VideoRoleInput<Role extends string> {
  readonly url: string;
  readonly role: Role;
}

export interface VideoGenerationRequest {
  readonly requestId: string;
  readonly model: VideoModel;
  readonly prompt: string;
  readonly durationSec: number;
  readonly aspectRatio: VideoAspectRatio;
  readonly resolution: VideoResolution;
  readonly generateAudio: boolean;
  readonly imageWithRoles: readonly VideoRoleInput<VideoImageRole>[];
  readonly videoWithRoles: readonly VideoRoleInput<typeof VIDEO_REFERENCE_ROLE>[];
  readonly audioWithRoles: readonly VideoRoleInput<typeof AUDIO_REFERENCE_ROLE>[];
  readonly seed?: number;
}

export interface VideoGenerationConfig {
  readonly endpoint: string;
  readonly statusEndpointBase: string;
  readonly apiKey: string;
}

export interface SubmittedVideoTask {
  readonly providerTaskId: string;
  readonly providerStatus: string;
  readonly status: VideoTaskStatus;
  readonly progress: number;
}

export type VideoTaskStatus = "running" | "completed" | "failed";

export interface ExtractedVideoStatus extends SubmittedVideoTask {
  readonly videoUrl: string | null;
  readonly format: string | null;
  readonly error: string | null;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface StoredVideo {
  readonly originalUrl: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly format: string;
  readonly durationSec: number; // 生成结果实际时长（秒，ffprobe）；未下载字节时为 0
}

export interface StoredVideoMaterial {
  readonly url: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly durationSec: number;
}

export interface StoredVideoFile extends StoredVideoMaterial {
  readonly format: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_VIDEO_BASE_URL = "https://toapis.com/v1";
const DEFAULT_VIDEO_MAX_BYTES = 350 * 1024 * 1024;

const MODEL_DISPLAY_NAMES: Record<VideoModel, string> = {
  "seedance-2": "Seedance-2.0",
  "seedance-2-fast": "Seedance-2.0 Fast",
  "seedance-2-mini": "Seedance-2.0 Mini",
};

const MODEL_RESOLUTIONS: Record<VideoModel, readonly VideoResolution[]> = {
  "seedance-2": ["480p", "720p", "1080p", "4k"],
  "seedance-2-fast": ["480p", "720p"],
  "seedance-2-mini": ["480p", "720p"],
};

export const VIDEO_PRICE_CONFIGS: readonly VideoPriceConfig[] = VIDEO_MODELS.flatMap((model) =>
  MODEL_RESOLUTIONS[model].flatMap((resolution) => [
    {
      resourceKey: videoGenerationResourceKey(model, resolution, false),
      displayName: `${MODEL_DISPLAY_NAMES[model]} ${resolution} 无输入视频`,
      model,
      resolution,
      hasInputVideo: false,
    },
    {
      resourceKey: videoGenerationResourceKey(model, resolution, true),
      displayName: `${MODEL_DISPLAY_NAMES[model]} ${resolution} 有输入视频`,
      model,
      resolution,
      hasInputVideo: true,
    },
  ]),
);

export function videoGenerationResourceKey(model: VideoModel, resolution: VideoResolution, hasInputVideo: boolean): string {
  return `video_${model.replaceAll("-", "_")}_${resolution.toLowerCase()}_${hasInputVideo ? "with_video" : "text"}`;
}

// 帮我写「拆解」一口价资源键：图片按张、视频按秒。后台资源价页可配、可停用。
export const VIDEO_ANALYZE_IMAGE_RESOURCE_KEY = "video_analyze_image";
export const VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY = "video_analyze_video_sec";
export const VIDEO_ANALYZE_PRICE_CONFIGS = [
  { resourceKey: VIDEO_ANALYZE_IMAGE_RESOURCE_KEY, displayName: "帮我写-图片拆解(按张)" },
  { resourceKey: VIDEO_ANALYZE_VIDEO_SEC_RESOURCE_KEY, displayName: "帮我写-视频拆解(按秒)" },
] as const;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl.trim() || DEFAULT_VIDEO_BASE_URL);
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function loadVideoGenerationConfig(env: NodeJS.ProcessEnv = process.env): VideoGenerationConfig {
  const apiKey = (env.VIDEO_API_KEY ?? env.TOAPIS_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("VIDEO_API_KEY/TOAPIS_API_KEY required");
  const base = normalizeBaseUrl(env.VIDEO_BASE_URL ?? env.TOAPIS_BASE_URL ?? DEFAULT_VIDEO_BASE_URL);
  return {
    endpoint: `${base}/videos/generations`,
    statusEndpointBase: `${base}/videos/generations`,
    apiKey,
  };
}

export function isResolutionSupported(model: VideoModel, resolution: VideoResolution): boolean {
  return MODEL_RESOLUTIONS[model].includes(resolution);
}

// 自动时长哨兵值：0 或 -1（仅 seedance-2 / seedance-2-fast 支持）。
export const MAX_VIDEO_DURATION_SEC = 15;

export function isAutoDuration(durationSec: number): boolean {
  return durationSec === 0 || durationSec === -1;
}

export function isDurationSupported(model: VideoModel, durationSec: number): boolean {
  if (isAutoDuration(durationSec)) return model !== "seedance-2-mini";
  if (model === "seedance-2-mini") return [4, 8, 10, 12, 15].includes(durationSec);
  return Number.isInteger(durationSec) && durationSec >= 4 && durationSec <= 15;
}

export function buildVideoGenerationPayload(request: VideoGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    client_business_id: request.requestId,
    prompt: request.prompt,
    duration: request.durationSec,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
  };
  if (request.seed !== undefined) body.seed = request.seed;
  if (request.model !== "seedance-2-mini") body.generate_audio = request.generateAudio;
  if (request.imageWithRoles.length > 0) body.image_with_roles = request.imageWithRoles;
  if (request.videoWithRoles.length > 0) body.video_with_roles = request.videoWithRoles;
  if (request.audioWithRoles.length > 0) body.audio_with_roles = request.audioWithRoles;
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateFromSeconds(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1000);
}

function normalizeProviderStatus(status: string): VideoTaskStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
}

function extractResultVideo(payload: Record<string, unknown>): { readonly url: string | null; readonly format: string | null } {
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.data) || result.data.length === 0) return { url: null, format: null };
  const first = result.data[0];
  if (!isRecord(first)) return { url: null, format: null };
  return {
    url: stringField(first, "url"),
    format: stringField(first, "format"),
  };
}

export function extractSubmittedVideoTask(payload: unknown): SubmittedVideoTask {
  if (!isRecord(payload)) throw new Error("video task response invalid");
  const providerTaskId = stringField(payload, "id");
  if (!providerTaskId) throw new Error("video task response missing id");
  const providerStatus = stringField(payload, "status") ?? "queued";
  return {
    providerTaskId,
    providerStatus,
    status: normalizeProviderStatus(providerStatus),
    progress: numberField(payload, "progress") ?? 0,
  };
}

function extractErrorMessage(record: Record<string, unknown>): string | null {
  const errObj = record.error;
  if (isRecord(errObj)) {
    // 上游失败常返回 { code, message }，两者都保留（code 往往才是真实原因，如 quota_not_enough）
    const code = stringField(errObj, "code");
    const message = stringField(errObj, "message");
    const combined = [code ? `[${code}]` : null, message].filter(Boolean).join(" ");
    return combined || null;
  }
  return stringField(record, "error");
}

export function extractVideoStatus(payload: unknown): ExtractedVideoStatus {
  const submitted = extractSubmittedVideoTask(payload);
  const record = payload as Record<string, unknown>;
  const result = extractResultVideo(record);
  const error = extractErrorMessage(record);
  return {
    ...submitted,
    videoUrl: result.url,
    format: result.format,
    error,
    completedAt: dateFromSeconds(numberField(record, "completed_at")),
    expiresAt: dateFromSeconds(numberField(record, "expires_at")),
  };
}

async function fetchWithTimeout(
  fetchFn: FetchLike,
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

export async function submitVideoGeneration(args: {
  readonly cfg: VideoGenerationConfig;
  readonly request: VideoGenerationRequest;
  readonly fetchFn: FetchLike;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<SubmittedVideoTask> {
  const response = await fetchWithTimeout(args.fetchFn, args.cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.cfg.apiKey}`,
    },
    body: JSON.stringify(buildVideoGenerationPayload(args.request)),
  }, args.timeoutMs, args.signal);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`video submit ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
  }
  return extractSubmittedVideoTask(await response.json());
}

export async function getVideoGenerationStatus(args: {
  readonly cfg: VideoGenerationConfig;
  readonly providerTaskId: string;
  readonly fetchFn: FetchLike;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ExtractedVideoStatus> {
  const response = await fetchWithTimeout(args.fetchFn, `${args.cfg.statusEndpointBase}/${encodeURIComponent(args.providerTaskId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${args.cfg.apiKey}` },
  }, args.timeoutMs, args.signal);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`video status ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
  }
  return extractVideoStatus(await response.json());
}

/**
 * 探测上游任务的存在性与状态，**把「上游没有这个任务」和「上游暂时答不了」分开**。
 *
 * `getVideoGenerationStatus` 对所有非 2xx 一律抛同一种 Error，404 与 500/超时/DNS
 * 长得一样。轮询主路径那样用没问题（抛出去就是失败退款，用户正在等着看结果）；
 * 但兜底扫的判断完全不同：把一次上游抖动当成「任务没了」去退款，会把仍在正常跑的
 * 长任务误杀 —— 用户拿到了货还被退了钱，比不退款更糟。
 *
 * 所以这里返回三态而不是抛：
 * - `found`  —— 拿到了状态，照 `status` 决定续跑还是结算
 * - `missing` —— 上游明确说没有（404/410），可以判失败退款
 * - `unknown` —— 其他任何情况（5xx、429、网络、超时、响应体解析失败），
 *   调用方**必须原样不动**，等下一轮再问。宁可多等一轮，不可错退一笔。
 *
 * 刻意不改 `getVideoGenerationStatus` 的签名与行为：它在轮询主路径上，改它影响面大。
 */
export type VideoStatusProbe =
  | { readonly kind: "found"; readonly status: ExtractedVideoStatus }
  | { readonly kind: "missing"; readonly httpStatus: number }
  | { readonly kind: "unknown"; readonly reason: string };

/** 上游明确表示「没有这个任务」的状态码。410 Gone 一并算上（任务过期被清掉）。 */
const PROVIDER_MISSING_STATUSES = new Set([404, 410]);

export async function probeVideoGenerationStatus(args: {
  readonly cfg: VideoGenerationConfig;
  readonly providerTaskId: string;
  readonly fetchFn: FetchLike;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<VideoStatusProbe> {
  let response: Response;
  try {
    response = await fetchWithTimeout(args.fetchFn, `${args.cfg.statusEndpointBase}/${encodeURIComponent(args.providerTaskId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${args.cfg.apiKey}` },
    }, args.timeoutMs, args.signal);
  } catch (error) {
    // 网络层失败（含超时触发的 abort）。说明不了上游有没有这个任务。
    return { kind: "unknown", reason: error instanceof Error ? error.message.slice(0, 200) : "fetch failed" };
  }
  if (PROVIDER_MISSING_STATUSES.has(response.status)) {
    return { kind: "missing", httpStatus: response.status };
  }
  if (!response.ok) {
    return { kind: "unknown", reason: `video status ${response.status}` };
  }
  try {
    return { kind: "found", status: extractVideoStatus(await response.json()) };
  } catch (error) {
    // 200 但响应体不是预期结构。同样不能据此断定任务不存在。
    return { kind: "unknown", reason: error instanceof Error ? error.message.slice(0, 200) : "bad status payload" };
  }
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv): string {
  const configuredBase = (env.VIDEO_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encodedKey = encodeObjectKey(key);
  if (configuredBase) return `${trimTrailingSlash(configuredBase)}/${encodedKey}`;
  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  return `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`;
}

function tryLoadS3(env: NodeJS.ProcessEnv): { readonly cfg: S3Config; readonly s3: ReturnType<typeof makeS3> } | null {
  try {
    const cfg = loadS3Config(env);
    return { cfg, s3: makeS3(cfg) };
  } catch {
    return null;
  }
}

function extensionFromMime(mime: string, fallbackFormat: string | null): string {
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  if (fallbackFormat?.trim()) return fallbackFormat.replace(/^\./, "").toLowerCase();
  return "mp4";
}

export async function storeGeneratedVideo(args: {
  readonly url: string;
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly format: string | null;
  readonly fetchFn: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<StoredVideo> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  if (!loaded) {
    return {
      originalUrl: args.url,
      objectKey: null,
      mime: "video/mp4",
      format: args.format ?? "mp4",
      durationSec: 0,
    };
  }
  const workdir = await mkdtemp(join(tmpdir(), "generated-video-"));
  const filePath = join(workdir, "source.video");
  try {
    const timedFetch = ((url: string | URL | Request, init?: RequestInit) =>
      fetchWithTimeout(args.fetchFn, String(url), init ?? {}, 120_000, args.signal)) as typeof fetch;
    const downloaded = await loadWorkflowMediaFile({
      source: { url: args.url, mime: "video/mp4" },
      outputPath: filePath,
      fetchFn: timedFetch,
      maxBytes: Number(env.VIDEO_MAX_BYTES) || DEFAULT_VIDEO_MAX_BYTES,
      fetchErrorMessage: (status) => `video download ${status}`,
    });
    const mime = downloaded.mime.startsWith("video/") ? downloaded.mime : "video/mp4";
    const durationSec = await probeVideoDurationSecFromFile(filePath);
    const extension = extensionFromMime(mime, args.format);
    const key = `workflow/videos/${args.userId}/${args.requestId}/${args.requestIndex}-${randomUUID()}.${extension}`;
    await putObjectFile(loaded.s3, key, filePath, mime, { acl: "public-read" });
    return {
      originalUrl: publicObjectUrl(loaded.cfg, key, env),
      objectKey: key,
      mime,
      format: extension,
      durationSec,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extensionFromFilename(filename: string, mime: string): string {
  const ext = filename.split(".").pop()?.trim().toLowerCase();
  if (ext && /^[a-z0-9]{2,8}$/.test(ext)) return ext;
  if (mime.startsWith("image/jpeg")) return "jpg";
  if (mime.startsWith("image/")) return "png";
  if (mime.startsWith("audio/mpeg")) return "mp3";
  if (mime.startsWith("audio/")) return "wav";
  if (mime.startsWith("video/webm")) return "webm";
  return "mp4";
}

export async function storeVideoMaterial(args: {
  readonly userId: string;
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<StoredVideoMaterial> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  const maxBytes = Number(env.VIDEO_MATERIAL_MAX_BYTES) || DEFAULT_VIDEO_MAX_BYTES;
  if (args.buffer.byteLength > maxBytes) throw new Error("video material too large");
  const safeMime = args.mime.trim() || "application/octet-stream";
  // 仅视频素材需要测量时长作为计费依据；图片/音频返回 0。
  const durationSec = safeMime.startsWith("video/") ? await probeVideoDurationSec(args.buffer) : 0;
  if (!loaded) {
    if (safeMime.startsWith("video/")) throw new Error("S3 required for video material upload");
    return {
      url: `data:${safeMime};base64,${args.buffer.toString("base64")}`,
      objectKey: null,
      mime: safeMime,
      durationSec,
    };
  }
  const ext = extensionFromFilename(args.filename, safeMime);
  const key = `workflow/video-materials/${args.userId}/${randomUUID()}.${ext}`;
  await putObject(loaded.s3, key, args.buffer, safeMime, { acl: "public-read" });
  return {
    url: publicObjectUrl(loaded.cfg, key, env),
    objectKey: key,
    mime: safeMime,
    durationSec,
  };
}

export async function storeVideoFile(args: {
  readonly userId: string;
  readonly filename: string;
  readonly mime: string;
  readonly filePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly folder?: string;
}): Promise<StoredVideoFile> {
  const env = args.env ?? process.env;
  const loaded = tryLoadS3(env);
  if (!loaded) throw new Error("S3 required for rendered video upload");
  const maxBytes = Number(env.VIDEO_MATERIAL_MAX_BYTES) || DEFAULT_VIDEO_MAX_BYTES;
  const fileInfo = await stat(args.filePath);
  if (fileInfo.size > maxBytes) throw new Error("rendered video too large");
  const safeMime = args.mime.trim() || "video/mp4";
  const durationSec = safeMime.startsWith("video/") ? await probeVideoDurationSecFromFile(args.filePath) : 0;
  const ext = extensionFromFilename(args.filename, safeMime);
  const folder = args.folder?.trim().replace(/^\/+|\/+$/g, "") || `workflow/rendered-videos/${args.userId}`;
  const key = `${folder}/${randomUUID()}.${ext}`;
  await putObjectFile(loaded.s3, key, args.filePath, safeMime, { acl: "public-read" });
  return {
    url: publicObjectUrl(loaded.cfg, key, env),
    objectKey: key,
    mime: safeMime,
    format: ext,
    durationSec,
  };
}
