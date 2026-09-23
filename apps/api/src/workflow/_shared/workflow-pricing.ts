import { imageGenerationResourceKey, imageModelResourceKey, type ImageResolutionLabel } from "./image-upstream-options.js";

/**
 * 电商长图拼接的资源 key，与模型/分辨率价格解析工具集中维护。
 */
export const ECOM_RESOURCE_KEYS = {
  stitch: "ecom_stitch",
} as const;


export interface WorkflowResourcePriceRow {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
}

export interface ResourcePriceLister {
  readonly listResourcePrices?: () => Promise<{ data: WorkflowResourcePriceRow[] }>;
}

/** 合并管理后台费率与内置默认值，未配置时回落默认，且 resourceKey 以默认值为准。 */
export function resolveResourcePrice(
  rows: readonly WorkflowResourcePriceRow[],
  fallback: WorkflowResourcePriceRow,
): WorkflowResourcePriceRow {
  const found = rows.find((row) => row.resourceKey === fallback.resourceKey);
  return found ? { ...fallback, ...found, resourceKey: fallback.resourceKey } : fallback;
}

const IMAGE_RESOLUTION_LABELS: readonly ImageResolutionLabel[] = ["1K", "2K", "4K"];
const IMAGE_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 0, "2K": 0, "4K": 0 };
const ECOM_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 0, "2K": 0, "4K": 0 };

function imagePriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: imageGenerationResourceKey(resolution),
    displayName: `图片生成 ${resolution}`,
    pricingType: "PER_UNIT",
    rate: IMAGE_DEFAULT_RATE[resolution],
    perUnits: 1,
    enabled: true,
  };
}

function ecomMasterPriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: imageGenerationResourceKey(resolution),
    displayName: `电商长图母版 ${resolution}`,
    pricingType: "PER_UNIT",
    rate: ECOM_DEFAULT_RATE[resolution],
    perUnits: 1,
    enabled: true,
  };
}

function ecomSegmentPriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: imageGenerationResourceKey(resolution),
    displayName: `电商长图分段 ${resolution}`,
    pricingType: "PER_UNIT",
    rate: ECOM_DEFAULT_RATE[resolution],
    perUnits: 1,
    enabled: true,
  };
}

export type ImagePricing = Record<ImageResolutionLabel, WorkflowResourcePriceRow>;

/**
 * 选择实际用于扣费/展示的价格行，优先级：
 *   1. 模块专属 key（dedicatedKey，如 ecom_main_image_generation_2k）——管理台已配置且启用时生效；
 *   2. 模型专属 key（image_generation_{model}_{res}）——同上；
 *   3. 通用分辨率 key（image_generation_{res}）——合并管理台费率与内置默认。
 * 专属 key 只有在管理台真实配置后才会命中，因此计费服务缺价不会导致扣费失败。
 */
export function resolveImageChargeRow(
  rows: readonly WorkflowResourcePriceRow[],
  args: {
    readonly resolution: ImageResolutionLabel;
    readonly model?: string;
    readonly dedicatedKey?: string;
    readonly fallback?: (resolution: ImageResolutionLabel) => WorkflowResourcePriceRow;
  },
): WorkflowResourcePriceRow {
  const candidates = [
    args.dedicatedKey,
    args.model ? imageModelResourceKey(args.model, args.resolution) : undefined,
  ].filter((key): key is string => Boolean(key));
  for (const key of candidates) {
    const found = rows.find((row) => row.resourceKey === key && row.enabled);
    if (found) return found;
  }
  return resolveResourcePrice(rows, (args.fallback ?? imagePriceFallback)(args.resolution));
}

/** 三档清晰度的模型/模块感知价格矩阵；billing 缺失时回落内置默认。 */
export async function resolveImagePricingMatrix(
  billing: ResourcePriceLister,
  args?: {
    readonly model?: string;
    readonly dedicatedKeyFor?: (resolution: ImageResolutionLabel) => string;
    readonly fallback?: (resolution: ImageResolutionLabel) => WorkflowResourcePriceRow;
  },
): Promise<ImagePricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  return IMAGE_RESOLUTION_LABELS.reduce((acc, resolution) => {
    acc[resolution] = resolveImageChargeRow(rows, {
      resolution,
      model: args?.model,
      dedicatedKey: args?.dedicatedKeyFor?.(resolution),
      fallback: args?.fallback,
    });
    return acc;
  }, {} as Record<ImageResolutionLabel, WorkflowResourcePriceRow>);
}

export { imagePriceFallback, ecomMasterPriceFallback, ecomSegmentPriceFallback, ecomMainImagePriceFallback };

const ECOM_MAIN_IMAGE_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 0, "2K": 0, "4K": 0 };

function ecomMainImagePriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: imageGenerationResourceKey(resolution),
    displayName: `电商主图 ${resolution}`,
    pricingType: "PER_UNIT",
    rate: ECOM_MAIN_IMAGE_DEFAULT_RATE[resolution],
    perUnits: 1,
    enabled: true,
  };
}
