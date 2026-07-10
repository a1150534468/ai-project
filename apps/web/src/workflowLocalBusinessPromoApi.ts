import { ApiError, readErrorMessage } from "./apiError";

export type LocalBusinessPromoDirection = "store-trust" | "service-showcase" | "offer-conversion" | "city-seeding";
export type LocalBusinessPromoDuration = 25 | 40 | 60;
export type LocalBusinessPromoAspectRatio = "9:16" | "16:9" | "1:1";
export type LocalBusinessPromoSubtitleStyle = "douyin-outline" | "xiaohongshu-clean" | "bottom-clean" | "none";
export type LocalBusinessPromoNarrationVoice = "vv-female-natural" | "vv-female-bright" | "vv-male-warm" | "vv-male-steady";
export type LocalBusinessPromoVoiceMode = "preset" | "design" | "clone";
export type LocalBusinessPromoVoiceTemplateKey = "local-business-guide";
export type LocalBusinessPromoMusicPreset = "light-explore" | "city-lively" | "warm-healing" | "premium-clean" | "no-bgm";
export type LocalBusinessPromoProjectStatus = "draft" | "generating" | "completed" | "failed";
export type LocalBusinessPromoRunStatus = "queued" | "running" | "merging" | "completed" | "failed";
export type LocalBusinessPromoProgressStage = "queued" | "analyzing" | "rendering" | "completed" | "failed";
export type LocalBusinessPromoMaterialGroup = "opening" | "process" | "environment" | "result";
export type WorkflowAudioKind = "voice-sample" | "narration" | "bgm";
export type WorkflowAudioTaskStatus = "running" | "completed" | "failed";

export interface LocalBusinessPromoOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

export interface LocalBusinessPromoNarrationVoiceOption {
  readonly value: LocalBusinessPromoNarrationVoice;
  readonly label: string;
  readonly description: string;
  readonly providerVoiceId: string;
}

export interface LocalBusinessPromoVoiceTemplate {
  readonly value: LocalBusinessPromoVoiceTemplateKey;
  readonly label: string;
  readonly description: string;
  readonly voiceDesignPrompt: string;
  readonly voiceStylePrompt: string;
}

export interface LocalBusinessPromoBrief {
  readonly storeName: string;
  readonly industry: string;
  readonly cityArea: string;
  readonly targetCustomers: string;
  readonly mainOffer: string;
  readonly sellingPoints: string;
}

export interface LocalBusinessPromoMaterialItem {
  readonly url: string;
  readonly mime: string;
  readonly name: string;
  readonly durationSec: number;
  readonly objectKey?: string | null;
}

export interface LocalBusinessPromoMaterials {
  readonly opening: readonly LocalBusinessPromoMaterialItem[];
  readonly process: readonly LocalBusinessPromoMaterialItem[];
  readonly environment: readonly LocalBusinessPromoMaterialItem[];
  readonly result: readonly LocalBusinessPromoMaterialItem[];
}

export interface LocalBusinessPromoSettings {
  readonly direction: LocalBusinessPromoDirection;
  readonly durationSec: LocalBusinessPromoDuration;
  readonly aspectRatio: LocalBusinessPromoAspectRatio;
  readonly subtitleStyle: LocalBusinessPromoSubtitleStyle;
  readonly narrationVoice: LocalBusinessPromoNarrationVoice;
  readonly voiceMode: LocalBusinessPromoVoiceMode;
  readonly voiceDesignPrompt: string;
  readonly voiceStylePrompt: string;
  readonly musicPreset: LocalBusinessPromoMusicPreset;
}

export interface LocalBusinessPromoProject {
  readonly id: string;
  readonly title: string;
  readonly brief: LocalBusinessPromoBrief;
  readonly materials: LocalBusinessPromoMaterials;
  readonly settings: LocalBusinessPromoSettings;
  readonly scriptDraft: string;
  readonly latestRunId: string | null;
  readonly status: LocalBusinessPromoProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowVideoAsset {
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
  readonly createdAt: string;
}

export interface WorkflowAudioAsset {
  readonly id: string;
  readonly kind: WorkflowAudioKind;
  readonly source: string;
  readonly provider: string | null;
  readonly providerModel: string | null;
  readonly projectId: string | null;
  readonly requestId: string | null;
  readonly originalUrl: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly format: string;
  readonly durationSec: number;
  readonly textContent: string | null;
  readonly metadata: unknown;
  readonly createdAt: string;
}

export interface WorkflowAudioTask {
  readonly id: string;
  readonly requestId: string;
  readonly kind: WorkflowAudioKind;
  readonly provider: string | null;
  readonly providerModel: string | null;
  readonly status: WorkflowAudioTaskStatus;
  readonly error: string | null;
  readonly inputPayload: unknown;
  readonly resultPayload: unknown;
  readonly assetId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface LocalBusinessPromoAudioState {
  readonly voiceCloneSample: WorkflowAudioAsset | null;
  readonly activeNarration: WorkflowAudioAsset | null;
  readonly activeBgm: WorkflowAudioAsset | null;
  readonly narrationHistory: readonly WorkflowAudioAsset[];
  readonly bgmHistory: readonly WorkflowAudioAsset[];
  readonly tasks: readonly WorkflowAudioTask[];
}

export interface LocalBusinessPromoShotPlanItem {
  readonly shotId: string;
  readonly label: string;
  readonly durationSec: number;
  readonly materialGroup: LocalBusinessPromoMaterialGroup;
  readonly fallbackGroups: readonly LocalBusinessPromoMaterialGroup[];
  readonly scriptLine: string;
  readonly prompt: string;
  readonly materials: readonly LocalBusinessPromoMaterialItem[];
  readonly requestId?: string;
  readonly taskId?: string | null;
  readonly taskStatus: "queued" | "running" | "completed" | "failed";
  readonly selectedMaterialUrl?: string | null;
  readonly selectedMaterialName?: string | null;
  readonly selectedMaterialMime?: string | null;
  readonly sourceStartSec?: number | null;
  readonly sourceEndSec?: number | null;
  readonly renderMode?: "video-cut" | "image-pan" | null;
  readonly assetId?: string | null;
  readonly assetUrl?: string | null;
  readonly error?: string | null;
}

export interface LocalBusinessPromoRun {
  readonly id: string;
  readonly projectId: string;
  readonly settingsSnapshot: LocalBusinessPromoSettings;
  readonly scriptSnapshot: string;
  readonly shotPlan: readonly LocalBusinessPromoShotPlanItem[];
  readonly mergedAssetId: string | null;
  readonly mergedAsset: WorkflowVideoAsset | null;
  readonly status: LocalBusinessPromoRunStatus;
  readonly progressPercent: number;
  readonly progressStage: LocalBusinessPromoProgressStage;
  readonly progressMessage: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface LocalBusinessPromoProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly status: LocalBusinessPromoProjectStatus;
  readonly latestRunId: string | null;
  readonly materialCount: number;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface LocalBusinessPromoState {
  readonly project: LocalBusinessPromoProject;
  readonly latestRun: LocalBusinessPromoRun | null;
  readonly runs: readonly LocalBusinessPromoRun[];
  readonly audio: LocalBusinessPromoAudioState;
}

export interface LocalBusinessPromoOptions {
  readonly directions: readonly LocalBusinessPromoOption<LocalBusinessPromoDirection>[];
  readonly durations: readonly LocalBusinessPromoOption<LocalBusinessPromoDuration>[];
  readonly aspectRatios: readonly LocalBusinessPromoOption<LocalBusinessPromoAspectRatio>[];
  readonly subtitleStyles: readonly LocalBusinessPromoOption<LocalBusinessPromoSubtitleStyle>[];
  readonly voiceModes: readonly LocalBusinessPromoOption<LocalBusinessPromoVoiceMode>[];
  readonly voiceTemplates: readonly LocalBusinessPromoVoiceTemplate[];
  readonly narrationVoices: readonly LocalBusinessPromoNarrationVoiceOption[];
  readonly musicPresets: readonly LocalBusinessPromoOption<LocalBusinessPromoMusicPreset>[];
}

type WorkflowResponse<T> = {
  readonly data: T;
};

async function requestLocalBusinessPromo<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly fallback: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetch(args.path, {
    method: args.method,
    headers: args.body === undefined
      ? { authorization: `Bearer ${args.token}` }
      : { "content-type": "application/json", authorization: `Bearer ${args.token}` },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, args.fallback), response.status);
  return ((await response.json()) as WorkflowResponse<T>).data;
}

export async function getLocalBusinessPromoOptions(token: string): Promise<LocalBusinessPromoOptions> {
  return requestLocalBusinessPromo<LocalBusinessPromoOptions>({
    token,
    path: "/api/workflow/local-business-promos/options",
    method: "GET",
    fallback: "获取配置失败",
  });
}

export async function listLocalBusinessPromoProjects(token: string): Promise<readonly LocalBusinessPromoProjectSummary[]> {
  return requestLocalBusinessPromo<readonly LocalBusinessPromoProjectSummary[]>({
    token,
    path: "/api/workflow/local-business-promos/projects",
    method: "GET",
    fallback: "获取项目失败",
  });
}

export async function createLocalBusinessPromoProject(
  token: string,
  payload: { title?: string } = {},
): Promise<LocalBusinessPromoProject> {
  const data = await requestLocalBusinessPromo<{ project: LocalBusinessPromoProject }>({
    token,
    path: "/api/workflow/local-business-promos/projects",
    method: "POST",
    fallback: "创建项目失败",
    body: payload,
  });
  return data.project;
}

export async function getLocalBusinessPromoProject(token: string, projectId: string): Promise<LocalBusinessPromoProject> {
  const data = await requestLocalBusinessPromo<{ project: LocalBusinessPromoProject }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}`,
    method: "GET",
    fallback: "获取项目失败",
  });
  return data.project;
}

export async function updateLocalBusinessPromoProject(
  token: string,
  projectId: string,
  payload: {
    title?: string;
    brief?: Partial<LocalBusinessPromoBrief>;
    materials?: LocalBusinessPromoMaterials;
    settings?: Partial<LocalBusinessPromoSettings>;
  },
): Promise<LocalBusinessPromoProject> {
  const data = await requestLocalBusinessPromo<{ project: LocalBusinessPromoProject }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}`,
    method: "PATCH",
    fallback: "保存项目失败",
    body: payload,
  });
  return data.project;
}

export async function generateLocalBusinessPromoScript(token: string, projectId: string): Promise<LocalBusinessPromoProject> {
  const data = await requestLocalBusinessPromo<{ project: LocalBusinessPromoProject }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/script/generate`,
    method: "POST",
    fallback: "生成口播文案失败",
  });
  return data.project;
}

export async function updateLocalBusinessPromoScript(
  token: string,
  projectId: string,
  scriptDraft: string,
): Promise<LocalBusinessPromoProject> {
  const data = await requestLocalBusinessPromo<{ project: LocalBusinessPromoProject }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/script`,
    method: "PATCH",
    fallback: "保存口播文案失败",
    body: { scriptDraft },
  });
  return data.project;
}

export async function generateLocalBusinessPromoVideo(
  token: string,
  projectId: string,
): Promise<LocalBusinessPromoRun> {
  const data = await requestLocalBusinessPromo<{ run: LocalBusinessPromoRun }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/generate`,
    method: "POST",
    fallback: "创建生成任务失败",
  });
  return data.run;
}

export async function listLocalBusinessPromoRuns(token: string, projectId: string): Promise<readonly LocalBusinessPromoRun[]> {
  const data = await requestLocalBusinessPromo<{ runs: readonly LocalBusinessPromoRun[] }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/runs`,
    method: "GET",
    fallback: "获取生成记录失败",
  });
  return data.runs;
}

export async function getLocalBusinessPromoState(token: string, projectId: string): Promise<LocalBusinessPromoState> {
  return requestLocalBusinessPromo<LocalBusinessPromoState>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/state`,
    method: "GET",
    fallback: "获取项目状态失败",
  });
}

export async function uploadLocalBusinessPromoVoiceSample(
  token: string,
  projectId: string,
  file: File,
): Promise<{ readonly asset: WorkflowAudioAsset; readonly audio: LocalBusinessPromoAudioState }> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/voice-sample`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "上传音色样本失败"), response.status);
  const body = (await response.json()) as WorkflowResponse<{
    readonly asset: WorkflowAudioAsset;
    readonly audio: LocalBusinessPromoAudioState;
  }>;
  return body.data;
}

export async function previewLocalBusinessPromoNarration(
  token: string,
  projectId: string,
): Promise<WorkflowAudioAsset> {
  const data = await requestLocalBusinessPromo<{ readonly asset: WorkflowAudioAsset }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/narration/preview`,
    method: "POST",
    fallback: "生成口播试听失败",
  });
  return data.asset;
}

export async function generateLocalBusinessPromoNarration(
  token: string,
  projectId: string,
): Promise<{
  readonly asset: WorkflowAudioAsset;
  readonly task: WorkflowAudioTask;
  readonly audio: LocalBusinessPromoAudioState;
}> {
  return requestLocalBusinessPromo<{
    readonly asset: WorkflowAudioAsset;
    readonly task: WorkflowAudioTask;
    readonly audio: LocalBusinessPromoAudioState;
  }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/narration/generate`,
    method: "POST",
    fallback: "生成正式口播失败",
  });
}

export async function previewLocalBusinessPromoBgm(
  token: string,
  projectId: string,
): Promise<WorkflowAudioAsset | null> {
  const data = await requestLocalBusinessPromo<{ readonly asset: WorkflowAudioAsset | null }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/bgm/preview`,
    method: "POST",
    fallback: "获取背景音乐试听失败",
  });
  return data.asset;
}

export async function uploadLocalBusinessPromoBgm(
  token: string,
  projectId: string,
  file: File,
): Promise<{ readonly asset: WorkflowAudioAsset; readonly audio: LocalBusinessPromoAudioState }> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/bgm-upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, "上传 BGM 失败"), response.status);
  const body = (await response.json()) as WorkflowResponse<{
    readonly asset: WorkflowAudioAsset;
    readonly audio: LocalBusinessPromoAudioState;
  }>;
  return body.data;
}

export async function generateLocalBusinessPromoBgm(
  token: string,
  projectId: string,
): Promise<{
  readonly asset: WorkflowAudioAsset | null;
  readonly task: WorkflowAudioTask | null;
  readonly audio: LocalBusinessPromoAudioState;
}> {
  return requestLocalBusinessPromo<{
    readonly asset: WorkflowAudioAsset | null;
    readonly task: WorkflowAudioTask | null;
    readonly audio: LocalBusinessPromoAudioState;
  }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/bgm/generate`,
    method: "POST",
    fallback: "生成背景音乐失败",
  });
}

export async function updateLocalBusinessPromoActiveAudio(
  token: string,
  projectId: string,
  payload: {
    narrationAssetId?: string | null;
    bgmAssetId?: string | null;
  },
): Promise<LocalBusinessPromoAudioState> {
  const data = await requestLocalBusinessPromo<{ readonly audio: LocalBusinessPromoAudioState }>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/active`,
    method: "PATCH",
    fallback: "切换音频版本失败",
    body: payload,
  });
  return data.audio;
}

export async function getLocalBusinessPromoAudioState(
  token: string,
  projectId: string,
): Promise<LocalBusinessPromoAudioState> {
  return requestLocalBusinessPromo<LocalBusinessPromoAudioState>({
    token,
    path: `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/state`,
    method: "GET",
    fallback: "获取音频状态失败",
  });
}
