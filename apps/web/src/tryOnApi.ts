import { ApiError, readErrorMessage } from "./apiError";

export type TryOnReferenceKind = "garment_front" | "garment_detail" | "model";
export type TryOnAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type TryOnResolution = "1K" | "2K" | "4K";
export type TryOnTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface TryOnModel {
  readonly value: string;
  readonly label: string;
  readonly supports1K: boolean;
  readonly supports4K: boolean;
}

export interface TryOnPrice {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly rate: number;
  readonly enabled: boolean;
}

export interface TryOnOptions {
  readonly model: string;
  readonly models: readonly TryOnModel[];
  readonly consentVersion: string;
  readonly aspectRatios: readonly TryOnAspectRatio[];
  readonly resolutions: readonly TryOnResolution[];
  readonly pricing: Record<TryOnResolution, TryOnPrice>;
  readonly pricingByModel: Readonly<Record<string, Readonly<Partial<Record<TryOnResolution, number>>>>>;
}

export interface TryOnReference {
  readonly id: string;
  readonly kind: TryOnReferenceKind;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly createdAt: string;
}

export interface TryOnOutput {
  readonly id: string;
  readonly index: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly originalUrl: string;
  readonly createdAt: string;
}

export interface TryOnTask {
  readonly id: string;
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: TryOnAspectRatio;
  readonly resolution: TryOnResolution;
  readonly count: number;
  readonly description: string;
  readonly garmentFrontAssetId: string;
  readonly garmentDetailAssetId: string | null;
  readonly modelAssetId: string | null;
  readonly status: TryOnTaskStatus;
  readonly completedCount: number;
  readonly error: string | null;
  readonly billingStatus: string;
  readonly outputs: readonly TryOnOutput[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface TryOnState {
  readonly references: readonly TryOnReference[];
  readonly tasks: readonly TryOnTask[];
}

export interface CreateTryOnPayload {
  readonly requestId: string;
  readonly model: string;
  readonly aspectRatio: TryOnAspectRatio;
  readonly resolution: TryOnResolution;
  readonly count: number;
  readonly garmentFrontAssetId: string;
  readonly garmentDetailAssetId?: string;
  readonly modelAssetId?: string;
  readonly description: string;
  readonly authorizationAccepted?: true;
  readonly consentVersion?: string;
}

async function requestTryOn<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly fallback: string;
}): Promise<T> {
  const response = await fetch(args.path, {
    method: args.method ?? "GET",
    headers:
      args.body === undefined
        ? { authorization: `Bearer ${args.token}` }
        : { authorization: `Bearer ${args.token}`, "content-type": "application/json" },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, args.fallback), response.status);
  const payload = (await response.json()) as { data?: T } & T;
  return payload.data ?? payload;
}

export function getTryOnOptions(token: string): Promise<TryOnOptions> {
  return requestTryOn({ token, path: "/api/workflow/try-ons/options", fallback: "获取服装试穿配置失败" });
}

export function getTryOnState(token: string): Promise<TryOnState> {
  return requestTryOn({ token, path: "/api/workflow/try-ons/state", fallback: "获取服装试穿任务失败" });
}

export function uploadTryOnReference(
  token: string,
  kind: TryOnReferenceKind,
  image: { readonly b64: string; readonly mime: string },
): Promise<{ readonly asset: TryOnReference }> {
  return requestTryOn({
    token,
    path: "/api/workflow/try-ons/references",
    method: "POST",
    body: { kind, image },
    fallback: "上传试穿素材失败",
  });
}

export function deleteTryOnReference(token: string, id: string): Promise<{ readonly success: boolean }> {
  return requestTryOn({
    token,
    path: `/api/workflow/try-ons/references/${encodeURIComponent(id)}`,
    method: "DELETE",
    fallback: "删除试穿素材失败",
  });
}

export function createTryOnTask(token: string, payload: CreateTryOnPayload): Promise<{ readonly task: TryOnTask }> {
  return requestTryOn({
    token,
    path: "/api/workflow/try-ons/generate",
    method: "POST",
    body: payload,
    fallback: "服装试穿生成失败",
  });
}

export function cancelTryOnTask(token: string, requestId: string): Promise<{ readonly task: TryOnTask }> {
  return requestTryOn({
    token,
    path: `/api/workflow/try-ons/tasks/${encodeURIComponent(requestId)}/cancel`,
    method: "POST",
    fallback: "取消试穿任务失败",
  });
}

export function deleteTryOnTask(token: string, requestId: string): Promise<{ readonly success: boolean }> {
  return requestTryOn({
    token,
    path: `/api/workflow/try-ons/tasks/${encodeURIComponent(requestId)}`,
    method: "DELETE",
    fallback: "删除试穿任务失败",
  });
}
