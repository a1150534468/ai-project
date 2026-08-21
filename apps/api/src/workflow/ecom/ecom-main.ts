export const ECOM_MAIN_RATIOS = ["1:1", "3:4", "4:5", "16:9", "9:16"] as const;
export type EcomMainRatio = (typeof ECOM_MAIN_RATIOS)[number];

export const ECOM_MAIN_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export type EcomMainResolution = (typeof ECOM_MAIN_RESOLUTIONS)[number];

export const ECOM_MAIN_STYLE_IDS = ["amazon_clean", "real_life", "premium_studio", "infographic", "short_video", "custom"] as const;
export type EcomMainStyleId = (typeof ECOM_MAIN_STYLE_IDS)[number];

export const ECOM_MAIN_STYLE_NAMES: Readonly<Record<EcomMainStyleId, string>> = {
  amazon_clean: "亚马逊干净商业风",
  real_life: "真人生活场景",
  premium_studio: "高端质感棚拍",
  infographic: "卖点标注信息图",
  short_video: "短视频电商风",
  custom: "客户自定义风格",
};

export const ECOM_MAIN_STYLES = ECOM_MAIN_STYLE_IDS.map((id) => ({ id, name: ECOM_MAIN_STYLE_NAMES[id] }));

export const ECOM_MAIN_MIN_COUNT = 1;
export const ECOM_MAIN_MAX_COUNT = 8;

const SIZE_TABLE: Readonly<Record<EcomMainRatio, Readonly<Record<EcomMainResolution, string>>>> = {
  "1:1": { "1K": "1024x1024", "2K": "1536x1536", "4K": "2496x2496" },
  "3:4": { "1K": "896x1152", "2K": "1344x1792", "4K": "2160x2880" },
  "4:5": { "1K": "1024x1280", "2K": "1536x1920", "4K": "2432x3040" },
  "16:9": { "1K": "1280x720", "2K": "1920x1080", "4K": "3200x1800" },
  "9:16": { "1K": "720x1280", "2K": "1080x1920", "4K": "1800x3200" },
};

export function isEcomMainRatio(value: string): value is EcomMainRatio {
  return ECOM_MAIN_RATIOS.some((item) => item === value);
}

export function isEcomMainStyle(value: string): value is EcomMainStyleId {
  return ECOM_MAIN_STYLE_IDS.some((item) => item === value);
}

export function normalizeEcomMainResolution(value: string | null | undefined): EcomMainResolution {
  const normalized = value?.trim().toUpperCase();
  return normalized && ECOM_MAIN_RESOLUTIONS.some((item) => item === normalized)
    ? (normalized as EcomMainResolution)
    : "1K";
}

export function ecomMainImageSize(ratio: EcomMainRatio, resolution: EcomMainResolution): string {
  return SIZE_TABLE[ratio][resolution];
}

export function ecomMainImageResourceKey(resolution: string | null | undefined): string {
  return `ecom_main_image_generation_${normalizeEcomMainResolution(resolution).toLowerCase()}`;
}

export function getEcomMainStyleName(id: string): string {
  return isEcomMainStyle(id) ? ECOM_MAIN_STYLE_NAMES[id] : ECOM_MAIN_STYLE_NAMES.amazon_clean;
}
