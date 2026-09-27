import { request } from "./http";

// 试甲台：手部照片是「主体」+ 只在指甲蒙版区域重绘。与万物试穿共用 human-image 档位，
// 但多了 mask（内联 PNG）与「手部锁定」语义，且每次生成都要确认授权。
export type NailReferenceKind = "hand" | "nail_design";
export type NailAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type NailResolution = "1K" | "2K" | "4K";
export type NailTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface NailModel {
  readonly value: string;
  readonly label: string;
  readonly supports1K: boolean;
  readonly supports4K: boolean;
  /** false 表示该模型不吃 mask（非 openai 协议），前端要提示「手部锁定不保证」。 */
  readonly supportsMask: boolean;
}

export interface NailPrice {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly rate: number;
  readonly enabled: boolean;
}

export interface NailOptions {
  readonly model: string;
  readonly models: readonly NailModel[];
  readonly consentVersion: string;
  readonly aspectRatios: readonly NailAspectRatio[];
  readonly resolutions: readonly NailResolution[];
  readonly pricing: Record<NailResolution, NailPrice>;
  readonly pricingByModel: Readonly<Record<string, Readonly<Partial<Record<NailResolution, number>>>>>;
}

export interface NailReference {
  readonly id: string;
  readonly kind: NailReferenceKind;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly createdAt: string;
}
export interface NailOutput {
  readonly id: string;
  readonly index: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly originalUrl: string;
  readonly createdAt: string;
}

export interface NailTask {
  readonly id: string;
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: NailAspectRatio;
  readonly resolution: NailResolution;
  readonly count: number;
  readonly description: string;
  readonly handAssetId: string;
  readonly nailDesignAssetId: string | null;
  readonly status: NailTaskStatus;
  readonly completedCount: number;
  readonly error: string | null;
  readonly billingStatus: string;
  readonly outputs: readonly NailOutput[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface NailState {
  readonly references: readonly NailReference[];
  readonly tasks: readonly NailTask[];
}

export interface CreateNailPayload {
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: NailAspectRatio;
  readonly resolution: NailResolution;
  readonly count: number;
  readonly handAssetId: string;
  readonly nailDesignAssetId?: string;
  /** 无损 PNG（带 alpha），透明处 = 指甲要重绘，不透明处 = 手部原样保留。 */
  readonly mask: { readonly b64: string };
  readonly description: string;
  /** 手部照片即主体，每次生成都必须确认授权，故非可选。 */
  readonly authorizationAccepted: true;
  readonly consentVersion: string;
}
function requestNail<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly fallback: string;
}): Promise<T> {
  return request<T>(args.path, {
    method: args.method ?? "GET",
    token: args.token,
    body: args.body,
    fallback: args.fallback,
  });
}

export function getNailTryOnOptions(token: string): Promise<NailOptions> {
  return requestNail({ token, path: "/api/workflow/nail-try-ons/options", fallback: "获取试甲台配置失败" });
}

export function getNailTryOnState(token: string): Promise<NailState> {
  return requestNail({ token, path: "/api/workflow/nail-try-ons/state", fallback: "获取试甲台任务失败" });
}

export function uploadNailTryOnReference(
  token: string,
  kind: NailReferenceKind,
  image: { readonly b64: string; readonly mime: string },
): Promise<{ readonly asset: NailReference }> {
  return requestNail({
    token,
    path: "/api/workflow/nail-try-ons/references",
    method: "POST",
    body: { kind, image },
    fallback: "上传试甲素材失败",
  });
}
export function deleteNailTryOnReference(token: string, id: string): Promise<{ readonly success: boolean }> {
  return requestNail({
    token,
    path: `/api/workflow/nail-try-ons/references/${encodeURIComponent(id)}`,
    method: "DELETE",
    fallback: "删除试甲素材失败",
  });
}

export function createNailTryOnTask(token: string, payload: CreateNailPayload): Promise<{ readonly task: NailTask }> {
  return requestNail({
    token,
    path: "/api/workflow/nail-try-ons/generate",
    method: "POST",
    body: payload,
    fallback: "试甲生成失败",
  });
}

export function cancelNailTryOnTask(token: string, requestId: string): Promise<{ readonly task: NailTask }> {
  return requestNail({
    token,
    path: `/api/workflow/nail-try-ons/tasks/${encodeURIComponent(requestId)}/cancel`,
    method: "POST",
    fallback: "取消试甲任务失败",
  });
}

export function deleteNailTryOnTask(token: string, requestId: string): Promise<{ readonly success: boolean }> {
  return requestNail({
    token,
    path: `/api/workflow/nail-try-ons/tasks/${encodeURIComponent(requestId)}`,
    method: "DELETE",
    fallback: "删除试甲任务失败",
  });
}



