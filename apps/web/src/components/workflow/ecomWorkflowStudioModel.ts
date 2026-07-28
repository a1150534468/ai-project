import { ApiError } from "../../apiError";
import * as workflowEcomApi from "../../workflowEcomApi";
import { isImageModel, type ImageModel } from "../../workflowState";
import type {
  WorkflowEcomMasterPayload,
  WorkflowEcomPlatform,
  WorkflowEcomPlatformId,
  WorkflowEcomResolution,
  WorkflowEcomSegment,
  WorkflowEcomSegmentIndex,
  WorkflowEcomTemplate,
  WorkflowEcomTemplateId,
  WorkflowEcomWorkflow,
} from "../../workflowEcomApi";

export const FALLBACK_PLATFORMS: readonly WorkflowEcomPlatform[] = [
  { id: "taobao", name: "淘宝", market: "domestic" },
  { id: "tmall", name: "天猫", market: "domestic" },
  { id: "jd", name: "京东", market: "domestic" },
  { id: "pdd", name: "拼多多", market: "domestic" },
  { id: "xianyu", name: "闲鱼", market: "domestic" },
  { id: "amazon", name: "Amazon", market: "foreign" },
  { id: "ebay", name: "eBay", market: "foreign" },
  { id: "etsy", name: "Etsy", market: "foreign" },
  { id: "shopee", name: "Shopee", market: "foreign" },
  { id: "lazada", name: "Lazada", market: "foreign" },
  { id: "shopify", name: "Shopify", market: "foreign" },
] as const;

export const FALLBACK_TEMPLATES: readonly WorkflowEcomTemplate[] = [
  { id: "general", name: "通用爆款", tag: "General", style: "Clean", master: "", segments: ["", "", ""] },
  { id: "premium", name: "高级感", tag: "Premium", style: "Premium", master: "", segments: ["", "", ""] },
  { id: "digital", name: "数码科技", tag: "Digital", style: "Tech", master: "", segments: ["", "", ""] },
  { id: "beauty", name: "美妆个护", tag: "Beauty", style: "Beauty", master: "", segments: ["", "", ""] },
  { id: "food", name: "食品饮料", tag: "Food", style: "Food", master: "", segments: ["", "", ""] },
  { id: "gift", name: "礼盒节庆", tag: "Gift", style: "Gift", master: "", segments: ["", "", ""] },
  { id: "apparel", name: "服饰穿搭", tag: "Apparel", style: "Fashion", master: "", segments: ["", "", ""] },
  { id: "home", name: "家居日用", tag: "Home", style: "Home", master: "", segments: ["", "", ""] },
] as const;

export const ECOM_MIN_SEGMENTS = 2;
export const ECOM_MAX_SEGMENTS = 8;
export const ECOM_SEGMENT_COUNT_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Array.from(
  { length: ECOM_MAX_SEGMENTS - ECOM_MIN_SEGMENTS + 1 },
  (_, i) => {
    const n = i + ECOM_MIN_SEGMENTS;
    return { value: String(n), label: `${n} 段` };
  },
);

export function segmentOrder(count: number): readonly number[] {
  const safe = Math.min(ECOM_MAX_SEGMENTS, Math.max(ECOM_MIN_SEGMENTS, Math.floor(count) || 3));
  return Array.from({ length: safe }, (_, i) => i);
}

export type EcomMasterDraft = {
  readonly platformId: WorkflowEcomPlatformId;
  readonly templateId: WorkflowEcomTemplateId;
  readonly resolution: WorkflowEcomResolution;
  /** null = 跟随服务端默认模型（历史工作流也可能没有存过模型） */
  readonly model: ImageModel | null;
  readonly productName: string;
  readonly category: string;
  readonly sellingPointsInput: string;
  readonly extra: string;
  readonly referenceAssetIds: readonly string[];
  readonly segmentCount: number;
};

export type EcomWorkflowStudioClient = Pick<
  typeof workflowEcomApi,
  | "getWorkflowEcomOptions"
  | "getWorkflowEcomPricing"
  | "getCurrentWorkflowEcom"
  | "createWorkflowEcomReference"
  | "createWorkflowEcomMaster"
  | "retryWorkflowEcomMaster"
  | "confirmWorkflowEcomSegments"
  | "redrawWorkflowEcomSegment"
  | "stitchWorkflowEcom"
  | "adoptWorkflowEcomMaster"
>;

type EcomWorkflowActionClient = Pick<
  EcomWorkflowStudioClient,
  "createWorkflowEcomMaster" | "retryWorkflowEcomMaster" | "confirmWorkflowEcomSegments" | "redrawWorkflowEcomSegment" | "stitchWorkflowEcom" | "adoptWorkflowEcomMaster"
>;

export type EcomWorkflowMutationState = {
  readonly isSubmittingMaster: boolean;
  readonly isRetryingMaster: boolean;
  readonly isConfirmingSegments: boolean;
  readonly isSavingStitched: boolean;
  readonly isStitchingPreview: boolean;
  readonly redrawingCount: number;
  readonly isServerGenerating: boolean;
};

export const ECOM_RESOLUTION_OPTIONS: readonly { readonly value: WorkflowEcomResolution; readonly label: string; readonly size: string }[] = [
  { value: "1K", label: "1K", size: "768x1024" },
  { value: "2K", label: "2K", size: "1536x2048" },
] as const;

/** 与现有 Qwen Image 编辑链路保持一致，避免第 4 张起稳定生成失败。 */
export const ECOM_MAX_REFERENCE_COUNT = 3;

/** 空值代表「默认模型」，下拉里用它当 option value。 */
export const ECOM_DEFAULT_MODEL_OPTION_VALUE = "";
export const ECOM_DEFAULT_MODEL_LABEL = "默认模型";

/**
 * 历史工作流 model 为 null 时不覆盖用户当前选择，也不把某个具体模型显示成已选中；
 * 只有工作流里存了合法模型才回填下拉。
 */
export function seedEcomModelSelection(
  current: ImageModel | null,
  workflowModel: string | null | undefined,
): ImageModel | null {
  return workflowModel && isImageModel(workflowModel) ? workflowModel : current;
}

function parseSellingPoints(input: string): readonly string[] {
  return input
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function formatEcomError(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status === 402
    ? "积分不足，请充值"
    : error instanceof Error
      ? error.message
      : fallback;
}

export function segmentByIndex(segments: readonly WorkflowEcomSegment[], index: WorkflowEcomSegmentIndex): WorkflowEcomSegment | null {
  return segments.find((segment) => segment.index === index) ?? null;
}

export function hasAllSegmentUrls(workflow: WorkflowEcomWorkflow | null): boolean {
  return workflow !== null && (workflow.stage === "segments_ready" || workflow.stage === "stitched") && segmentOrder(workflow.segmentCount).every((index) => {
    const segment = segmentByIndex(workflow.segments, index);
    return segment !== null && segment.originalUrl.trim().length > 0;
  });
}

export function describeEcomWorkflowStage(workflow: WorkflowEcomWorkflow | null): string {
  if (workflow?.stage === "master_running") return "母版正在生成中，离开页面后回来会继续显示当前任务。";
  if (workflow?.stage === "segments_running") return "三段分段正在生成中，三段图片齐全后才可拼接保存。";
  return workflow?.masterAsset
    ? "母版已生成，可继续确认分段或重试主图。"
    : workflow?.masterAssetId
      ? "母版已生成，但当前接口未返回预览地址。"
      : "先生成母版，再确认分段。当前界面只展示接口已知的状态与分段结果。";
}

export function isEcomWorkflowMutating(state: EcomWorkflowMutationState): boolean {
  return state.isServerGenerating || state.isSubmittingMaster || state.isRetryingMaster || state.isConfirmingSegments || state.isSavingStitched || state.isStitchingPreview || state.redrawingCount > 0;
}

export function canSaveEcomStitchedPreview(args: {
  readonly canStitch: boolean;
  readonly hasWorkflow: boolean;
  readonly hasPreview: boolean;
  readonly isWorkflowMutating: boolean;
}): boolean {
  return args.canStitch && args.hasWorkflow && args.hasPreview && !args.isWorkflowMutating;
}

export async function readFileAsInlineImage(file: File): Promise<{ readonly b64: string; readonly mime: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("参考图读取失败"));
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.readAsDataURL(file);
  });
  const [prefix, b64] = dataUrl.split(",", 2);
  return { b64, mime: prefix.match(/^data:(.+);base64$/)?.[1] || file.type || "image/png" };
}

export function createEcomMasterPayload(input: EcomMasterDraft): WorkflowEcomMasterPayload {
  return {
    platformId: input.platformId,
    templateId: input.templateId,
    resolution: input.resolution,
    model: input.model ?? undefined,
    product: {
      name: input.productName.trim(),
      category: input.category.trim(),
      sellingPoints: parseSellingPoints(input.sellingPointsInput),
      extra: input.extra.trim(),
    },
    referenceAssetIds: input.referenceAssetIds,
    segmentCount: input.segmentCount,
  };
}

export function createEcomWorkflowActions(client: EcomWorkflowActionClient, token: string) {
  return {
    createMaster: (input: EcomMasterDraft) => client.createWorkflowEcomMaster(token, createEcomMasterPayload(input)),
    retryMaster: (workflowId: string) => client.retryWorkflowEcomMaster(token, workflowId),
    confirmSegments: (workflowId: string) => client.confirmWorkflowEcomSegments(token, workflowId),
    redrawSegment: (workflowId: string, index: WorkflowEcomSegmentIndex) => client.redrawWorkflowEcomSegment(token, workflowId, index),
    saveStitched: (workflowId: string, b64: string) => client.stitchWorkflowEcom(token, workflowId, { b64, mime: "image/png" }),
    adoptMaster: (input: EcomMasterDraft, masterAssetId: string) => client.adoptWorkflowEcomMaster(token, { ...createEcomMasterPayload(input), masterAssetId }),
  };
}
