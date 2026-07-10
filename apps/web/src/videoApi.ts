import { ApiError, readErrorMessage } from "./apiError";

export type VideoModel = "seedance-2" | "seedance-2-fast" | "seedance-2-mini";
export type VideoAspectRatio = "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type VideoResolution = "480p" | "720p" | "1080p" | "4k";
export type VideoTaskStatus = "running" | "completed" | "failed";

// 自动时长哨兵值（下单发 0，后端 0/-1 均识别；仅 seedance-2 / fast 支持）。
export const AUTO_DURATION = 0;

export interface DurationOption {
  readonly value: number;
  readonly label: string;
}

// 素材上限：全模型统一 9 图 / 3 视频 / 3 音频。
export const VIDEO_MATERIAL_LIMITS = { image: 9, video: 3, audio: 3 } as const;
export type MaterialKind = keyof typeof VIDEO_MATERIAL_LIMITS;

export const MODEL_RESOLUTION_OPTIONS: Record<VideoModel, VideoResolution[]> = {
  "seedance-2": ["480p", "720p", "1080p", "4k"],
  "seedance-2-fast": ["480p", "720p"],
  "seedance-2-mini": ["480p", "720p"],
};

const FIXED_DURATIONS_FULL: DurationOption[] = [4, 5, 6, 8, 10, 12, 15].map((v) => ({ value: v, label: `${v}s` }));
const FIXED_DURATIONS_MINI: DurationOption[] = [4, 8, 10, 12, 15].map((v) => ({ value: v, label: `${v}s` }));
const AUTO_OPTION: DurationOption = { value: AUTO_DURATION, label: "自动" };

// seedance-2 / fast 支持自动时长；mini 仅固定档、无自动。
export const MODEL_DURATION_OPTIONS: Record<VideoModel, DurationOption[]> = {
  "seedance-2": [AUTO_OPTION, ...FIXED_DURATIONS_FULL],
  "seedance-2-fast": [AUTO_OPTION, ...FIXED_DURATIONS_FULL],
  "seedance-2-mini": FIXED_DURATIONS_MINI,
};

export function materialKindOf(mime: string): MaterialKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

// mini 仅支持离散档 [4,8,10,12,15]；2.0 / fast 支持任意整数 4-15（与后端 isDurationSupported 一致）。
export const MINI_DURATIONS = [4, 8, 10, 12, 15];
export function isDurationValid(model: VideoModel, durationSec: number): boolean {
  if (model === "seedance-2-mini") return MINI_DURATIONS.includes(durationSec);
  return Number.isInteger(durationSec) && durationSec >= 4 && durationSec <= 15;
}

// 切模型时把不被支持的分辨率/时长回退到合法值（默认 15s；已去掉「自动」档）。
export function clampVideoSettings(model: VideoModel, resolution: VideoResolution, durationSec: number): { resolution: VideoResolution; durationSec: number } {
  const resolutions = MODEL_RESOLUTION_OPTIONS[model];
  return {
    resolution: resolutions.includes(resolution) ? resolution : resolutions[0],
    durationSec: isDurationValid(model, durationSec) ? durationSec : 15,
  };
}

export interface WorkflowVideoAsset {
  id: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  originalUrl: string;
  mime: string;
  format: string;
  createdAt: string;
}

export interface WorkflowVideoTask {
  id: string;
  requestId: string;
  providerTaskId: string | null;
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  generateAudio: boolean;
  hasInputVideo: boolean;
  resourceKey: string;
  chargedPoints: number;
  status: VideoTaskStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkflowVideoPricingRow {
  resourceKey: string;
  displayName: string;
  model: VideoModel;
  resolution: VideoResolution;
  hasInputVideo: boolean;
  pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  rate: number;
  outputRate: number;
  perUnits: number;
  enabled: boolean;
}

export interface WorkflowVideoState {
  videos: WorkflowVideoAsset[];
  tasks: WorkflowVideoTask[];
}

export interface GenerateWorkflowVideoPayload {
  requestId: string;
  prompt: string;
  model: VideoModel;
  durationSec: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  generateAudio: boolean;
  imageWithRoles?: Array<{ url: string; role: "first_frame" | "last_frame" | "reference_image" }>;
  videoWithRoles?: Array<{ url: string; role: "reference_video" }>;
  audioWithRoles?: Array<{ url: string; role: "reference_audio" }>;
}

export interface GenerateWorkflowVideoResult {
  task: WorkflowVideoTask;
  videos: WorkflowVideoAsset[];
}

export interface UploadedVideoMaterial {
  url: string;
  objectKey: string | null;
  mime: string;
  durationSec: number;
}

export async function getWorkflowVideoState(token: string): Promise<WorkflowVideoState> {
  const response = await fetch("/api/workflow/videos/state", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "获取视频任务失败"), response.status);
  const body = (await response.json()) as { data: WorkflowVideoState };
  return {
    videos: body.data?.videos ?? [],
    tasks: body.data?.tasks ?? [],
  };
}

export async function listWorkflowVideoPricing(token: string): Promise<WorkflowVideoPricingRow[]> {
  const response = await fetch("/api/workflow/videos/pricing", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "获取视频价格失败"), response.status);
  const body = (await response.json()) as { data: WorkflowVideoPricingRow[] };
  return body.data ?? [];
}

export async function generateWorkflowVideo(token: string, payload: GenerateWorkflowVideoPayload): Promise<GenerateWorkflowVideoResult> {
  const response = await fetch("/api/workflow/videos/generate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "生成视频失败"), response.status);
  const body = (await response.json()) as { data: GenerateWorkflowVideoResult };
  return body.data;
}

export async function optimizeWorkflowVideoPrompt(
  token: string,
  payload: { prompt: string; materials?: { image: number; video: number; audio: number } },
): Promise<string> {
  const response = await fetch("/api/workflow/videos/optimize-prompt", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "提示词优化失败"), response.status);
  const body = (await response.json()) as { data: { optimized: string } };
  return body.data.optimized;
}

export async function uploadWorkflowVideoMaterial(token: string, file: File): Promise<UploadedVideoMaterial> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/workflow/videos/materials", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "上传素材失败"), response.status);
  const body = (await response.json()) as { data: UploadedVideoMaterial };
  return body.data;
}

// —— 帮我写向导 ——
export interface MaterialInsight {
  materials: Array<{ index: number; description: string }>;
  insight: {
    productName: string;
    category: string;
    features: string[];
    sellingPoints: string[];
    audience: string[];
    scenes: string[];
  };
}

export interface ReferenceBreakdown {
  script: string;
  highlights: string[];
}

export interface ScriptGenPayload {
  insight: MaterialInsight["insight"];
  business: string;
  language: string;
  contentType: string;
  shootType: string;
  note: string;
  durationSec: number;
  hasNarration?: boolean;
  materials?: { image: number; video: number; audio: number };
  reference?: ReferenceBreakdown;
}

export async function analyzeMaterialsApi(
  token: string,
  payload: { requestId: string; materials: Array<{ url: string; mime: string }> },
): Promise<MaterialInsight> {
  const response = await fetch("/api/workflow/videos/analyze-materials", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "素材分析失败"), response.status);
  return ((await response.json()) as { data: MaterialInsight }).data;
}

export async function analyzeReferenceApi(token: string, file: File): Promise<ReferenceBreakdown> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/workflow/videos/analyze-reference", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "参考视频拆解失败"), response.status);
  return ((await response.json()) as { data: ReferenceBreakdown }).data;
}

export interface AnalyzeRate {
  rate: number;
  perUnits: number;
  enabled: boolean;
}
export interface AnalyzePricing {
  image: AnalyzeRate;
  videoSec: AnalyzeRate;
}

export async function listAnalyzePricing(token: string): Promise<AnalyzePricing> {
  const response = await fetch("/api/workflow/videos/analyze-pricing", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "获取拆解价格失败"), response.status);
  return ((await response.json()) as { data: AnalyzePricing }).data;
}

export async function generateScriptApi(token: string, payload: ScriptGenPayload): Promise<string> {
  const response = await fetch("/api/workflow/videos/generate-script", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "脚本生成失败"), response.status);
  return ((await response.json()) as { data: { script: string } }).data.script;
}
