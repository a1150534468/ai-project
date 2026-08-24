import { request } from "./http";

export type PortraitPresetId =
  | "business-elite"
  | "linkedin"
  | "id-photo"
  | "guofeng"
  | "sunny-casual"
  | "poster"
  | "wedding"
  | "student-id"
  | "founder-ip"
  | "hk-retro"
  | "oil-painting"
  | "ink-gongbi"
  | "magazine"
  | "cyberpunk"
  | "fairytale"
  | "custom";
export type PortraitPresetFinish = "photo" | "art";
export type PortraitAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
export type PortraitResolution = "1K" | "2K" | "4K";
export type PortraitTaskStatus = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type PortraitPreset = { readonly id: PortraitPresetId; readonly name: string; readonly description: string; readonly finish?: PortraitPresetFinish };
export type PortraitModel = { readonly value: string; readonly label: string; readonly supports4K: boolean; readonly supports1K?: boolean };
export type PortraitPrice = { readonly resourceKey: string; readonly displayName: string; readonly rate: number; readonly enabled: boolean };
export type PortraitOptions = {
  readonly model: string;
  readonly models?: readonly PortraitModel[];
  readonly consentVersion: string;
  readonly presets: readonly PortraitPreset[];
  readonly aspectRatios: readonly PortraitAspectRatio[];
  readonly resolutions: readonly PortraitResolution[];
  readonly pricing: Record<PortraitResolution, PortraitPrice>;
  readonly pricingByModel?: Readonly<Record<string, Readonly<Partial<Record<PortraitResolution, number>>>>>;
  /** 旧版模板 id → 可读名称，仅历史任务展示用；老服务端不返回该字段 */
  readonly legacyPresetNames?: Readonly<Record<string, string>>;
};
export type PortraitReference = {
  readonly id: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly createdAt: string;
};
export type PortraitOutput = {
  readonly id: string;
  readonly index: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly originalUrl: string;
  readonly createdAt: string;
};
export type PortraitTask = {
  readonly id: string;
  readonly requestId: string;
  readonly model: string;
  /** 历史任务可能保存旧版模板 id，因此不限定为当前 PortraitPresetId */
  readonly presetId: string;
  readonly aspectRatio: PortraitAspectRatio;
  readonly resolution: PortraitResolution;
  readonly count: number;
  readonly prompt: string;
  readonly referenceAssetIds: readonly string[];
  readonly status: PortraitTaskStatus;
  readonly completedCount: number;
  readonly error: string | null;
  readonly billingStatus: string;
  readonly outputs: readonly PortraitOutput[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
};
export type PortraitState = { readonly references: readonly PortraitReference[]; readonly tasks: readonly PortraitTask[] };
export type PortraitPromptOptions = {
  readonly scene: string;
  readonly outfit: string;
  readonly composition: string;
  readonly expression: string;
  readonly hair: string;
  readonly makeup: string;
  readonly extraPrompt: string;
};
export type CreatePortraitPayload = {
  readonly requestId: string;
  readonly presetId: PortraitPresetId;
  readonly model: string;
  readonly aspectRatio: PortraitAspectRatio;
  readonly resolution: PortraitResolution;
  readonly count: number;
  readonly referenceAssetIds: readonly string[];
  readonly options: PortraitPromptOptions;
  readonly authorizationAccepted: true;
  readonly consentVersion: string;
};

export function getPortraitOptions(token: string): Promise<PortraitOptions> {
  return request("/api/workflow/portraits/options", { token, fallback: "获取形象照配置失败" });
}

export function getPortraitState(token: string): Promise<PortraitState> {
  return request("/api/workflow/portraits/state", { token, fallback: "获取形象照任务失败" });
}

export function uploadPortraitReference(token: string, image: { readonly b64: string; readonly mime: string }): Promise<{ readonly asset: PortraitReference }> {
  return request("/api/workflow/portraits/references", { method: "POST", token, body: { image }, fallback: "上传形象参考照失败" });
}

export function deletePortraitReference(token: string, id: string): Promise<{ readonly success: boolean }> {
  return request(`/api/workflow/portraits/references/${encodeURIComponent(id)}`, { method: "DELETE", token, fallback: "删除参考照失败" });
}

export function createPortraitTask(token: string, payload: CreatePortraitPayload): Promise<{ readonly task: PortraitTask }> {
  return request("/api/workflow/portraits/generate", { method: "POST", token, body: payload, fallback: "形象照生成失败" });
}

export function cancelPortraitTask(token: string, requestId: string): Promise<{ readonly task: PortraitTask }> {
  return request(`/api/workflow/portraits/tasks/${encodeURIComponent(requestId)}/cancel`, { method: "POST", token, fallback: "取消形象照任务失败" });
}

export function deletePortraitTask(token: string, requestId: string): Promise<{ readonly success: boolean }> {
  return request(`/api/workflow/portraits/tasks/${encodeURIComponent(requestId)}`, { method: "DELETE", token, fallback: "删除形象照任务失败" });
}
