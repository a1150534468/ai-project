export const ECOM_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export type EcomResolution = (typeof ECOM_RESOLUTIONS)[number];

const ECOM_SIZE_BY_RESOLUTION: Readonly<Record<EcomResolution, string>> = {
  "1K": "768x1024",
  "2K": "1536x2048",
  "4K": "2480x3312",
};

export function isEcomResolution(value: string): value is EcomResolution {
  return ECOM_RESOLUTIONS.some((item) => item === value);
}

export function normalizeEcomResolution(value: string | null | undefined): EcomResolution {
  const normalized = value?.trim().toUpperCase();
  return normalized && isEcomResolution(normalized) ? normalized : "1K";
}

export function ecomSizeForResolution(resolution: string | null | undefined): string {
  return ECOM_SIZE_BY_RESOLUTION[normalizeEcomResolution(resolution)];
}

export function ecomMasterResourceKey(resolution: string | null | undefined): string {
  return `ecom_master_generation_${normalizeEcomResolution(resolution).toLowerCase()}`;
}

export function ecomSegmentResourceKey(resolution: string | null | undefined): string {
  return `ecom_segment_generation_${normalizeEcomResolution(resolution).toLowerCase()}`;
}
