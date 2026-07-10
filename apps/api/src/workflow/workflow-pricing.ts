import { ecomMasterResourceKey, ecomSegmentResourceKey } from "./ecom-resolution.js";
import { ECOM_RESOURCE_KEYS } from "./ecom-route-helpers.js";
import { ecomMainImageResourceKey } from "./ecom-main.js";
import { imageGenerationResourceKey, type ImageResolutionLabel } from "./image-upstream-options.js";

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
const IMAGE_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 10, "2K": 20, "4K": 40 };
const ECOM_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 10, "2K": 20, "4K": 40 };
const ECOM_STITCH_DEFAULT_RATE = 1;

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
    resourceKey: ecomMasterResourceKey(resolution),
    displayName: `电商长图母版 ${resolution}`,
    pricingType: "PER_UNIT",
    rate: ECOM_DEFAULT_RATE[resolution],
    perUnits: 1,
    enabled: true,
  };
}

function ecomSegmentPriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: ecomSegmentResourceKey(resolution),
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

const ECOM_MAIN_IMAGE_DEFAULT_RATE: Readonly<Record<ImageResolutionLabel, number>> = { "1K": 10, "2K": 20, "4K": 40 };

function ecomMainImagePriceFallback(resolution: ImageResolutionLabel): WorkflowResourcePriceRow {
  return {
    resourceKey: ecomMainImageResourceKey(resolution),
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
