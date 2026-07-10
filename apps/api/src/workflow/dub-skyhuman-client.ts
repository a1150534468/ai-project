import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface SkyhumanConfig { readonly apiKey: string; readonly baseUrl: string }
export type SkyTaskStatus = "running" | "completed" | "failed";

export class SkyhumanError extends Error {
  readonly name = "SkyhumanError";
  constructor(readonly code: number, message: string) { super(message); }
}

export function loadSkyhumanConfig(env: NodeJS.ProcessEnv = process.env): SkyhumanConfig {
  const apiKey = env.SKYHUMAN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("SKYHUMAN_API_TOKEN required");
  const baseUrl = (env.SKYHUMAN_BASE_URL?.trim() || "https://skyhumanapi.pilihu.vip").replace(/\/+$/u, "");
  return { apiKey, baseUrl };
}

export function mapSkyStatus(status: number): SkyTaskStatus {
  if (status === 3) return "completed";
  if (status === 4) return "failed";
  return "running"; // 1 等待 / 2 处理
}

const envelope = z.object({ code: z.number(), message: z.string().nullish() });

/**
 * 飞天在「等待中/处理中」阶段会把结果字段填成 null（avatar / video_url / duration / cost）。
 * zod 的 .optional() 只接受 undefined，不接受 null —— 直接 parse 会在第一次轮询就抛 ZodError，
 * 导致克隆/成片必定失败。所以结果字段一律 .nullish()，并把校验异常包成 SkyhumanError。
 */
/** 上游对类型不严谨（id 可能是数字、status 可能是字符串），宽松收敛，避免整条链路因类型挂掉 */
const idSchema = z.union([z.string(), z.number()]).transform(String);
const statusSchema = z.coerce.number();

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new SkyhumanError(-1, `飞天${what}响应格式异常`);
  return r.data;
}

async function call(cfg: SkyhumanConfig, fetchFn: FetchLike, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new SkyhumanError(2003, "飞天 token 无效");
  if (!res.ok) throw new SkyhumanError(-1, `skyhuman http ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const env = parseOrThrow(envelope, body, "");
  if (env.code !== 0) throw new SkyhumanError(env.code, env.message ?? `skyhuman code ${env.code}`);
  return body;
}

export async function createUploadUrl(cfg: SkyhumanConfig, fetchFn: FetchLike, fileExtension: string): Promise<{ uploadUrl: string; contentType: string; fileId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/upload/create_upload_url", { method: "POST", body: JSON.stringify({ file_extension: fileExtension }) });
  const d = parseOrThrow(z.object({ upload_url: z.string(), content_type: z.string(), file_id: z.string() }), body.data, "上传地址");
  return { uploadUrl: d.upload_url, contentType: d.content_type, fileId: d.file_id };
}

export async function putToPresigned(fetchFn: FetchLike, uploadUrl: string, contentType: string, body: Buffer): Promise<void> {
  const res = await fetchFn(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: body as unknown as BodyInit });
  if (!res.ok) throw new SkyhumanError(-1, `presigned put http ${res.status}`);
}

export async function createAvatarByVideo(cfg: SkyhumanConfig, fetchFn: FetchLike, args: { title: string; videoUrl?: string; fileId?: string }): Promise<{ taskId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/avatar/create_by_video", {
    method: "POST",
    body: JSON.stringify({ title: args.title, ...(args.videoUrl ? { video_url: args.videoUrl } : {}), ...(args.fileId ? { file_id: args.fileId } : {}) }),
  });
  return { taskId: parseOrThrow(idSchema, body.task_id, "建数字人") };
}

export async function getAvatarTask(cfg: SkyhumanConfig, fetchFn: FetchLike, taskId: string): Promise<{ status: SkyTaskStatus; avatarCode?: string; message?: string }> {
  const body = await call(cfg, fetchFn, `/api/v2/fly/avatar/task?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
  const d = parseOrThrow(z.object({ status: statusSchema, avatar: z.string().nullish(), message: z.string().nullish() }), body, "数字人任务");
  // 飞天失败时 code 仍是 0，真实原因（如「视频中未检测到人脸」）只在 message 里 —— 必须透出给用户
  return { status: mapSkyStatus(d.status), ...(d.avatar ? { avatarCode: d.avatar } : {}), ...(d.message ? { message: d.message } : {}) };
}

export async function deleteAvatar(cfg: SkyhumanConfig, fetchFn: FetchLike, avatarCode: string): Promise<void> {
  await call(cfg, fetchFn, "/api/v2/fly/avatar/delete", { method: "POST", body: JSON.stringify({ avatar_code: avatarCode }) });
}

export async function createVideoByAudio(cfg: SkyhumanConfig, fetchFn: FetchLike, args: { avatar: string; audioUrl?: string; fileId?: string; title: string }): Promise<{ taskId: string }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/video/create_by_audio", {
    method: "POST",
    body: JSON.stringify({ avatar: args.avatar, title: args.title, ...(args.audioUrl ? { audio_url: args.audioUrl } : {}), ...(args.fileId ? { file_id: args.fileId } : {}) }),
  });
  return { taskId: parseOrThrow(idSchema, body.task_id, "成片") };
}

export async function getVideoTask(cfg: SkyhumanConfig, fetchFn: FetchLike, taskId: string): Promise<{ status: SkyTaskStatus; videoUrl?: string; duration?: number; cost?: number; message?: string }> {
  const body = await call(cfg, fetchFn, `/api/v2/fly/video/task?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
  const d = parseOrThrow(z.object({ status: statusSchema, video_url: z.string().nullish(), duration: z.coerce.number().nullish(), cost: z.coerce.number().nullish(), message: z.string().nullish() }), body, "视频任务");
  return { status: mapSkyStatus(d.status), ...(d.video_url ? { videoUrl: d.video_url } : {}), ...(d.duration != null ? { duration: d.duration } : {}), ...(d.cost != null ? { cost: d.cost } : {}), ...(d.message ? { message: d.message } : {}) };
}

export async function getCredit(cfg: SkyhumanConfig, fetchFn: FetchLike): Promise<{ left: number }> {
  const body = await call(cfg, fetchFn, "/api/v2/fly/account/credit", { method: "GET" });
  return { left: parseOrThrow(z.number(), body.left, "余额") };
}
