import { imageGenerationResourceKey, imageModelResourceKey, type ImageResolutionLabel } from "./image-upstream-options.js";

/**
 * 电商长图拼接的计费 key。放在这里而不是 ecom 域：本文件的默认费率表要用它，
 * 而 ecom 域反过来要用本文件的 `WorkflowResourcePriceRow`，放在域里就成了模块环。
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
const ECOM_STITCH_DEFAULT_RATE = 0;

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

const ECOM_STITCH_PRICE_FALLBACK: WorkflowResourcePriceRow = {
  resourceKey: ECOM_RESOURCE_KEYS.stitch,
  displayName: "电商长图拼接",
  pricingType: "PER_CALL",
  rate: ECOM_STITCH_DEFAULT_RATE,
  perUnits: 1,
  enabled: true,
};

export type ImagePricing = Record<ImageResolutionLabel, WorkflowResourcePriceRow>;

export interface EcomPricing {
  readonly master: Record<ImageResolutionLabel, WorkflowResourcePriceRow>;
  readonly segment: Record<ImageResolutionLabel, WorkflowResourcePriceRow>;
  readonly stitch: WorkflowResourcePriceRow;
}

function byResolution(
  rows: readonly WorkflowResourcePriceRow[],
  fallback: (resolution: ImageResolutionLabel) => WorkflowResourcePriceRow,
): Record<ImageResolutionLabel, WorkflowResourcePriceRow> {
  return IMAGE_RESOLUTION_LABELS.reduce((acc, resolution) => {
    acc[resolution] = resolveResourcePrice(rows, fallback(resolution));
    return acc;
  }, {} as Record<ImageResolutionLabel, WorkflowResourcePriceRow>);
}

/** 生图三档清晰度价格；billing 缺失或无 listResourcePrices 时回落默认。 */
export async function resolveImagePricing(billing: ResourcePriceLister): Promise<ImagePricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  return byResolution(rows, imagePriceFallback);
}

/** 电商长图母版/分段/拼接价格；billing 缺失或无 listResourcePrices 时回落默认。 */
export async function resolveEcomPricing(billing: ResourcePriceLister): Promise<EcomPricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  return {
    master: byResolution(rows, ecomMasterPriceFallback),
    segment: byResolution(rows, ecomSegmentPriceFallback),
    stitch: resolveResourcePrice(rows, ECOM_STITCH_PRICE_FALLBACK),
  };
}

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

export type EcomMainImagePricing = Record<ImageResolutionLabel, WorkflowResourcePriceRow>;

/** 电商主图三档清晰度价格；billing 缺失或无 listResourcePrices 时回落默认。 */
export async function resolveEcomMainImagePricing(billing: ResourcePriceLister): Promise<EcomMainImagePricing> {
  const rows = billing.listResourcePrices ? (await billing.listResourcePrices()).data ?? [] : [];
  return byResolution(rows, ecomMainImagePriceFallback);
}
