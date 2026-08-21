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

const QWEN_ECOM_IMAGE_MODEL = "qwen-image-2.0-pro-2026-04-22";
const GPT_ECOM_IMAGE_MODEL = "gpt-image-2";
const QWEN_MIN_TOTAL_PIXELS = 512 * 512;
const QWEN_MAX_TOTAL_PIXELS = 2048 * 2048;
const GPT_MIN_TOTAL_PIXELS = 655_360;
const GPT_MAX_TOTAL_PIXELS = 8_294_400;
const GPT_MAX_EDGE = 3_840;
const GPT_MAX_ASPECT_RATIO = 3;

function parseSize(size: string): { readonly width: number; readonly height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function isQwenImageSizeSupported(size: string): boolean {
  const parsed = parseSize(size);
  if (!parsed) return false;
  const pixels = parsed.width * parsed.height;
  return pixels >= QWEN_MIN_TOTAL_PIXELS && pixels <= QWEN_MAX_TOTAL_PIXELS;
}

export function isGptImageSizeSupported(size: string): boolean {
  const parsed = parseSize(size);
  if (!parsed) return false;
  const { width, height } = parsed;
  const pixels = width * height;
  const longEdge = Math.max(width, height);
  return width % 16 === 0
    && height % 16 === 0
    && pixels >= GPT_MIN_TOTAL_PIXELS
    && pixels <= GPT_MAX_TOTAL_PIXELS
    && longEdge <= GPT_MAX_EDGE
    && longEdge / Math.min(width, height) <= GPT_MAX_ASPECT_RATIO;
}

/** model 为空表示跟随服务端默认模型，不做本地尺寸限制；豆包由 seedreamSize 兜底，直接放行。 */
export function ecomModelSizeError(model: string | null | undefined, size: string, supportedHint?: string): string | null {
  if (!model) return null;
  if (model === QWEN_ECOM_IMAGE_MODEL && !isQwenImageSizeSupported(size)) {
    return "Qwen 模型最高支持 2K，请切换清晰度或模型";
  }
  if (model === GPT_ECOM_IMAGE_MODEL && !isGptImageSizeSupported(size)) {
    return `GPT Image 2 不支持尺寸 ${size}，${supportedHint ?? "请切换清晰度、比例或模型"}`;
  }
  return null;
}
