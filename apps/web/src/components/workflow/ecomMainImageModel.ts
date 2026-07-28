import { ApiError } from "../../apiError";
import type { ImageModel } from "../../workflowState";
import type { CreateEcomMainPayload, EcomMainRatio, EcomMainResolution, EcomMainStyleId } from "../../workflowEcomMainApi";

export const ECOM_MAIN_RATIO_OPTIONS: readonly { readonly value: EcomMainRatio; readonly label: string }[] = [
  { value: "1:1", label: "1:1 方图" },
  { value: "3:4", label: "3:4 竖图" },
  { value: "4:5", label: "4:5 电商竖图" },
  { value: "16:9", label: "16:9 横图" },
  { value: "9:16", label: "9:16 竖屏" },
];

export const ECOM_MAIN_RESOLUTION_OPTIONS: readonly { readonly value: EcomMainResolution; readonly label: string }[] = [
  { value: "1K", label: "1K 标清" },
  { value: "2K", label: "2K 高清" },
];

export const ECOM_MAIN_STYLE_OPTIONS: readonly { readonly value: EcomMainStyleId; readonly label: string }[] = [
  { value: "amazon_clean", label: "亚马逊干净商业风" },
  { value: "real_life", label: "真人生活场景" },
  { value: "premium_studio", label: "高端质感棚拍" },
  { value: "infographic", label: "卖点标注信息图" },
  { value: "short_video", label: "短视频电商风" },
  { value: "custom", label: "客户自定义风格" },
];

export const ECOM_MAIN_COUNT_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 张` }));

export const ECOM_MAIN_TEXT_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "with", label: "有字（画面叠加卖点）" },
  { value: "no", label: "无字（干净不叠字）" },
];

/**
 * 主图尺寸表，与服务端 apps/api/src/workflow/ecom-main.ts 的 SIZE_TABLE 保持一致。
 * 前端不能 import 服务端代码，所以在此复制一份；改服务端表时必须同步改这里。
 */
export const ECOM_MAIN_SIZE_TABLE: Readonly<Record<EcomMainRatio, Readonly<Record<EcomMainResolution, string>>>> = {
  "1:1": { "1K": "1024x1024", "2K": "1536x1536", "4K": "2496x2496" },
  "3:4": { "1K": "896x1152", "2K": "1344x1792", "4K": "2160x2880" },
  "4:5": { "1K": "1024x1280", "2K": "1536x1920", "4K": "2432x3040" },
  "16:9": { "1K": "1280x720", "2K": "1920x1080", "4K": "3200x1800" },
  "9:16": { "1K": "720x1280", "2K": "1080x1920", "4K": "1800x3200" },
};

// 与服务端 apps/api/src/workflow/ecom-resolution.ts 的模型尺寸门禁常量一致。
const QWEN_IMAGE_MODEL = "qwen-image-2.0-pro-2026-04-22";
const GPT_IMAGE_MODEL = "gpt-image-2";
const QWEN_MIN_TOTAL_PIXELS = 512 * 512;
const QWEN_MAX_TOTAL_PIXELS = 2048 * 2048;
const GPT_MIN_TOTAL_PIXELS = 655_360;
const GPT_MAX_TOTAL_PIXELS = 8_294_400;
const GPT_MAX_EDGE = 3_840;
const GPT_MAX_ASPECT_RATIO = 3;

export function ecomMainImageSize(ratio: EcomMainRatio, resolution: EcomMainResolution): string {
  return ECOM_MAIN_SIZE_TABLE[ratio][resolution];
}

function parseSize(size: string): { readonly width: number; readonly height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 服务端会用同一条规则 400，前端提前判定，保证界面上没有可提交的非法组合。 */
export function isEcomMainSizeSupported(model: ImageModel | null | undefined, size: string): boolean {
  if (!model) return true;
  const parsed = parseSize(size);
  if (!parsed) return false;
  const { width, height } = parsed;
  const pixels = width * height;
  if (model === QWEN_IMAGE_MODEL) {
    return pixels >= QWEN_MIN_TOTAL_PIXELS && pixels <= QWEN_MAX_TOTAL_PIXELS;
  }
  if (model === GPT_IMAGE_MODEL) {
    const longEdge = Math.max(width, height);
    return width % 16 === 0
      && height % 16 === 0
      && pixels >= GPT_MIN_TOTAL_PIXELS
      && pixels <= GPT_MAX_TOTAL_PIXELS
      && longEdge <= GPT_MAX_EDGE
      && longEdge / Math.min(width, height) <= GPT_MAX_ASPECT_RATIO;
  }
  return true;
}

/** 该模型 + 比例下这一档清晰度是否会被服务端拒绝。 */
export function isEcomMainResolutionBlocked(
  model: ImageModel | null | undefined,
  resolution: EcomMainResolution,
  ratio: EcomMainRatio = "1:1",
): boolean {
  return !isEcomMainSizeSupported(model, ecomMainImageSize(ratio, resolution));
}

/** 当前模型 + 比例下可用的清晰度档位（按 UI 开放的档位过滤）。 */
export function allowedEcomMainResolutions(
  model: ImageModel | null | undefined,
  ratio: EcomMainRatio,
): readonly EcomMainResolution[] {
  return ECOM_MAIN_RESOLUTION_OPTIONS
    .map((option) => option.value)
    .filter((value) => !isEcomMainResolutionBlocked(model, value, ratio));
}

/** 切换模型/比例后修正清晰度：被屏蔽档位回落到仍可用的最高档，全被屏蔽时保底 1K。 */
export function coerceEcomMainResolution(
  model: ImageModel | null | undefined,
  resolution: EcomMainResolution,
  ratio: EcomMainRatio = "1:1",
): EcomMainResolution {
  if (!isEcomMainResolutionBlocked(model, resolution, ratio)) return resolution;
  const allowed = allowedEcomMainResolutions(model, ratio);
  return allowed.length > 0 ? allowed[allowed.length - 1] : "1K";
}

export interface MainImageDraft {
  readonly platformId: string;
  readonly ratio: EcomMainRatio;
  readonly resolution: EcomMainResolution;
  readonly model: ImageModel;
  readonly style: EcomMainStyleId;
  readonly customStyle: string;
  readonly withText: boolean;
  readonly productName: string;
  readonly category: string;
  readonly sellingPointsInput: string;
  readonly extra: string;
  readonly referenceAssetIds: readonly string[];
  readonly count: number;
}

function parseSellingPoints(input: string): readonly string[] {
  return input.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function buildCreateMainPayload(draft: MainImageDraft): CreateEcomMainPayload {
  return {
    platformId: draft.platformId,
    ratio: draft.ratio,
    resolution: coerceEcomMainResolution(draft.model, draft.resolution, draft.ratio),
    model: draft.model,
    style: draft.style,
    customStyle: draft.customStyle.trim(),
    withText: draft.withText,
    count: draft.count,
    product: {
      name: draft.productName.trim(),
      category: draft.category.trim(),
      sellingPoints: parseSellingPoints(draft.sellingPointsInput),
      extra: draft.extra.trim(),
    },
    referenceAssetIds: draft.referenceAssetIds,
  };
}

export function estimateMainPointCost(perImageRate: number | null, count: number): number | null {
  return perImageRate === null ? null : perImageRate * count;
}

export function formatEcomMainError(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status === 402
    ? "积分不足，请充值"
    : error instanceof Error ? error.message : fallback;
}

export function isMainJobGenerating(stage: string | null | undefined): boolean {
  return stage === "running";
}
