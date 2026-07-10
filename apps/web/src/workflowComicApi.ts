import { ApiError, readErrorMessage } from "./apiError";

export type ComicStage = "script" | "assets" | "storyboard" | "render";
export type ComicAssetType = "character" | "scene" | "prop" | "style";

export interface ComicProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly logline: string;
  readonly style: string;
  readonly status: string;
  readonly currentStage: ComicStage;
  readonly updatedAt: string;
}

export interface ComicBibleEntry {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly content: string;
  readonly position: number;
  readonly updatedAt: string;
}

export interface ComicScriptVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly status: string;
  readonly outline: string;
  readonly scriptText: string;
  readonly source: string;
  readonly prompt: string;
  readonly updatedAt: string;
}

export interface ComicEpisode {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly episodeNo: number;
  readonly targetDurationSec: number;
  readonly currentStage: ComicStage;
  readonly scriptVersionId: string | null;
  readonly updatedAt: string;
  readonly scriptVersions: readonly ComicScriptVersion[];
}

export interface ComicProjectDetail extends ComicProjectSummary {
  readonly bibleEntries: readonly ComicBibleEntry[];
  readonly episodes: readonly ComicEpisode[];
}

export interface ComicAsset {
  readonly id: string;
  readonly type: ComicAssetType;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly imageAssetId: string | null;
  readonly imageUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly source: string;
  readonly updatedAt: string;
}

export interface ComicShot {
  readonly id: string;
  readonly episodeId: string;
  readonly shotNo: number;
  readonly title: string;
  readonly description: string;
  readonly dialogue: string;
  readonly camera: string;
  readonly durationSec: number;
  readonly assetIds: readonly string[];
  readonly imageAssetId: string | null;
  readonly imageUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly videoUrl: string | null;
  readonly videoStatus: string;
  readonly videoTaskId: string | null;
  readonly updatedAt: string;
}

export interface ComicVideoModel {
  readonly id: string;
  readonly label: string;
  readonly resolution: string;
  readonly minDurationSec: number;
  readonly maxDurationSec: number;
  readonly pointsPerSecond: number;
}

export interface ComicRenderManifest {
  readonly episodeId: string;
  readonly status: string;
  readonly totalDurationSec: number;
  readonly segments: readonly {
    readonly shotId: string;
    readonly shotNo: number;
    readonly videoUrl: string;
    readonly durationSec: number;
  }[];
}

type ComicResponse<T> = { readonly data: T };
type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

async function requestComic<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method: RequestMethod;
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
  const payload: ComicResponse<T> = await response.json();
  return payload.data;
}

export function listComicProjects(token: string): Promise<readonly ComicProjectSummary[]> {
  return requestComic({ token, path: "/api/workflow/comics/projects", method: "GET", fallback: "获取漫剧项目失败" });
}

export function createComicProject(token: string, body: { readonly title: string; readonly logline: string; readonly style: string }): Promise<ComicProjectSummary> {
  return requestComic({ token, path: "/api/workflow/comics/projects", method: "POST", fallback: "创建漫剧项目失败", body });
}

export function getComicProject(token: string, projectId: string): Promise<ComicProjectDetail> {
  return requestComic({ token, path: `/api/workflow/comics/projects/${encodeURIComponent(projectId)}`, method: "GET", fallback: "获取漫剧项目详情失败" });
}

export function createComicBibleEntry(token: string, projectId: string, body: { readonly category: string; readonly title: string; readonly content: string; readonly position: number }): Promise<ComicBibleEntry> {
  return requestComic({ token, path: `/api/workflow/comics/projects/${encodeURIComponent(projectId)}/bible`, method: "POST", fallback: "保存漫剧设定失败", body });
}

export function createComicEpisode(token: string, projectId: string, body: { readonly title: string; readonly summary: string; readonly targetDurationSec: number }): Promise<ComicEpisode> {
  return requestComic({ token, path: `/api/workflow/comics/projects/${encodeURIComponent(projectId)}/episodes`, method: "POST", fallback: "创建剧集失败", body });
}

export function createComicScriptVersion(token: string, episodeId: string, body: { readonly outline: string; readonly scriptText: string; readonly source: "manual"; readonly prompt: string }): Promise<ComicScriptVersion> {
  return requestComic({ token, path: `/api/workflow/comics/episodes/${encodeURIComponent(episodeId)}/script`, method: "POST", fallback: "保存脚本失败", body });
}

export function activateComicScriptVersion(token: string, versionId: string): Promise<ComicScriptVersion> {
  return requestComic({ token, path: `/api/workflow/comics/script-versions/${encodeURIComponent(versionId)}/activate`, method: "POST", fallback: "激活脚本失败" });
}

export function listComicAssets(token: string, projectId: string): Promise<readonly ComicAsset[]> {
  return requestComic({ token, path: `/api/workflow/comics/projects/${encodeURIComponent(projectId)}/assets`, method: "GET", fallback: "获取资产失败" });
}

export function createComicAsset(token: string, projectId: string, body: { readonly type: ComicAssetType; readonly name: string; readonly description: string; readonly prompt: string }): Promise<ComicAsset> {
  return requestComic({ token, path: `/api/workflow/comics/projects/${encodeURIComponent(projectId)}/assets`, method: "POST", fallback: "创建资产失败", body });
}

export function generateComicAssetImage(token: string, assetId: string, prompt: string): Promise<ComicAsset> {
  return requestComic({ token, path: `/api/workflow/comics/assets/${encodeURIComponent(assetId)}/generate-image`, method: "POST", fallback: "生成资产图失败", body: { prompt } });
}

export function listComicShots(token: string, episodeId: string): Promise<readonly ComicShot[]> {
  return requestComic({ token, path: `/api/workflow/comics/episodes/${encodeURIComponent(episodeId)}/shots`, method: "GET", fallback: "获取分镜失败" });
}

export function generateComicShots(token: string, episodeId: string): Promise<readonly ComicShot[]> {
  return requestComic({ token, path: `/api/workflow/comics/episodes/${encodeURIComponent(episodeId)}/shots/generate`, method: "POST", fallback: "生成分镜失败", body: { replaceExisting: true } });
}

export function generateComicShotImage(token: string, shotId: string, prompt: string): Promise<ComicShot> {
  return requestComic({ token, path: `/api/workflow/comics/shots/${encodeURIComponent(shotId)}/generate-image`, method: "POST", fallback: "生成镜头图失败", body: { prompt } });
}

export function listComicVideoModels(token: string): Promise<readonly ComicVideoModel[]> {
  return requestComic({ token, path: "/api/workflow/comics/video/models", method: "GET", fallback: "获取视频模型失败" });
}

export function generateComicShotVideo(token: string, shotId: string, modelId: string): Promise<ComicShot> {
  return requestComic({ token, path: `/api/workflow/comics/shots/${encodeURIComponent(shotId)}/generate-video`, method: "POST", fallback: "生成镜头视频失败", body: { modelId } });
}

export function pollComicShotVideo(token: string, shotId: string): Promise<ComicShot> {
  return requestComic({ token, path: `/api/workflow/comics/shots/${encodeURIComponent(shotId)}/poll-video`, method: "POST", fallback: "刷新视频状态失败" });
}

export function renderComicEpisode(token: string, episodeId: string): Promise<ComicRenderManifest> {
  return requestComic({ token, path: `/api/workflow/comics/episodes/${encodeURIComponent(episodeId)}/render`, method: "POST", fallback: "渲染剧集失败" });
}
