import { ApiError } from "../../apiError";
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
  { value: "4K", label: "4K 超清" },
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

export interface MainImageDraft {
  readonly platformId: string;
  readonly ratio: EcomMainRatio;
  readonly resolution: EcomMainResolution;
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
    resolution: draft.resolution,
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
