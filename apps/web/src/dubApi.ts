import { ApiError, readErrorMessage } from "./apiError";

export interface PriceRow { rate: number; perUnits: number; enabled: boolean }
export interface DubPricing { analyzeVideoSec: PriceRow; ttsChar: PriceRow; avatarClone: PriceRow; videoSec: PriceRow; parseVideo: PriceRow }
export interface DubAnalysis { spokenScript: string; shotScript: string; structure: string; highlights: string[] }
export interface DubParseResult {
  title: string;
  cover: { url: string };
  video: { url: string; objectKey: string; durationSec: number; sizeBytes: number };
  chargedPoints: number;
}
export interface DubAvatar { id: string; avatarCode: string; title: string; isFavorite: boolean; createdAt: string }
export interface DubBgm { id: string; title: string; url: string }
export interface DubProject {
  id: string; title: string; analysis: DubAnalysis | null; script: string | null;
  attachedKbIds: string[]; ttsMode: string | null;
  audioUrl: string | null; audioObjectKey: string | null; audioDurationSec: number;
  avatarId: string | null; bgmPresetId: string | null; bgmObjectKey: string | null; bgmVolume: number;
  resultVideoUrl: string | null; finalVideoUrl: string | null; stage: string; error: string | null;
  createdAt: string;
}
export type TtsMode = "preset" | "design" | "clone";
export interface PresetVoice { id: string; label: string; lang: "zh" | "en"; gender: "male" | "female" }
export interface DubTask { id: string; kind: string; status: "running" | "completed" | "failed"; resultPayload: unknown; error: string | null }

const base = "/api/workflow/dub";

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function unwrap<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new ApiError(await readErrorMessage(res, fallback), res.status);
  const body = (await res.json()) as { data: T };
  return body.data;
}

async function getJson<T>(token: string, path: string, fallback: string): Promise<T> {
  return unwrap<T>(await fetch(`${base}${path}`, { method: "GET", headers: authHeaders(token) }), fallback);
}

async function sendJson<T>(token: string, path: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res, fallback);
}

async function sendForm<T>(token: string, path: string, file: File, fallback: string): Promise<T> {
  const form = new FormData();
  form.set("file", file);
  return unwrap<T>(await fetch(`${base}${path}`, { method: "POST", headers: authHeaders(token), body: form }), fallback);
}

export const getDubPricing = (t: string) => getJson<DubPricing>(t, "/pricing", "获取价格失败");
export const listPresetVoices = (t: string) => getJson<PresetVoice[]>(t, "/tts/voices", "获取音色失败");
export const listBgmPresets = (t: string) => getJson<DubBgm[]>(t, "/bgm", "获取配乐失败");
export const listAvatars = (t: string) => getJson<DubAvatar[]>(t, "/avatars", "获取形象失败");
export const getTask = (t: string, id: string) => getJson<DubTask>(t, `/tasks/${id}`, "获取任务失败");

export const createProject = (t: string, title?: string) => sendJson<DubProject>(t, "/projects", "POST", { title }, "创建项目失败");
export const getProject = (t: string, id: string) => getJson<DubProject>(t, `/projects/${id}`, "获取项目失败");
export const listProjects = (t: string) => getJson<DubProject[]>(t, "/projects", "获取项目失败");
export const patchProject = (t: string, id: string, patch: Record<string, unknown>) => sendJson<null>(t, `/projects/${id}`, "PATCH", patch, "保存失败");
export const deleteProject = (t: string, id: string) => sendJson<null>(t, `/projects/${id}`, "DELETE", {}, "删除失败");
export const generateProjectVideo = (t: string, id: string) => sendJson<{ taskId: string }>(t, `/projects/${id}/generate`, "POST", {}, "成片失败");
export const remixProject = (t: string, id: string) => sendJson<null>(t, `/projects/${id}/remix`, "POST", {}, "重新配乐失败");

export const analyzeVideo = (t: string, file: File) => sendForm<DubAnalysis>(t, "/analyze", file, "视频拆解失败");
export const uploadBgm = (t: string, file: File) => sendForm<{ url: string; objectKey: string }>(t, "/bgm/upload", file, "上传配乐失败");
export const deleteAvatar = (t: string, id: string) => sendJson<null>(t, `/avatars/${id}`, "DELETE", {}, "删除形象失败");
export const favoriteAvatar = (t: string, id: string, favorite: boolean) => sendJson<null>(t, `/avatars/${id}`, "PATCH", { favorite }, "操作失败");

export async function createAvatar(token: string, file: File, title: string): Promise<{ taskId: string }> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch(`${base}/avatars?title=${encodeURIComponent(title)}`, { method: "POST", headers: authHeaders(token), body: form });
  return unwrap<{ taskId: string }>(res, "创建数字人失败");
}

export interface RewriteInput { text: string; kbIds?: string[]; highlights?: string[]; injectHighlights?: boolean; style?: string }
export async function rewriteScript(token: string, input: RewriteInput): Promise<string> {
  const d = await sendJson<{ script: string }>(token, "/rewrite", "POST", input, "洗稿失败");
  return d.script;
}

export interface TtsInput { mode: TtsMode; text: string; format?: "wav" | "mp3"; voice?: string; description?: string; style?: string; refAudioBase64?: string; refAudioMime?: string }
export const generateTts = (t: string, input: TtsInput) =>
  sendJson<{ audioUrl: string; objectKey: string; durationSec: number; chargedPoints: number }>(t, "/tts", "POST", input, "语音合成失败");

export const parseShare = (t: string, text: string) => sendJson<DubParseResult>(t, "/parse", "POST", { text }, "链接解析失败");
export const analyzeParsed = (t: string, objectKey: string) => sendJson<DubAnalysis>(t, "/analyze-parsed", "POST", { objectKey }, "视频拆解失败");
