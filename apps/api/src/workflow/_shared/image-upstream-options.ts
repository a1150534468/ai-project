export type ImageResolutionLabel = "1K" | "2K" | "4K";

type ResolutionKey = Lowercase<ImageResolutionLabel>;
type RatioPreset = Readonly<Record<ResolutionKey, string>>;

const DEFAULT_IMAGE_SIZE = "1024x1024";
const RESOLUTION_KEYS: readonly ResolutionKey[] = ["1k", "2k", "4k"];
const RESOLUTION_LABELS = new Set<ImageResolutionLabel>(["1K", "2K", "4K"]);

const SIZES_BY_RATIO: Readonly<Record<string, RatioPreset>> = {
  "1:1": { "1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880" },
  "4:3": { "1k": "1024x768", "2k": "2048x1536", "4k": "3312x2480" },
  "3:4": { "1k": "768x1024", "2k": "1536x2048", "4k": "2480x3312" },
  "3:2": { "1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2336" },
  "2:3": { "1k": "1024x1536", "2k": "1360x2048", "4k": "2336x3520" },
  "16:9": { "1k": "1536x864", "2k": "2048x1152", "4k": "3840x2160" },
  "9:16": { "1k": "864x1536", "2k": "1152x2048", "4k": "2160x3840" },
  "21:9": { "1k": "2016x864", "2k": "2688x1152", "4k": "3840x1648" },
};

interface ImagePreset {
  readonly ratio: string;
  readonly resolution: ResolutionKey;
}

const PRESET_BY_SIZE = new Map<string, ImagePreset>();
for (const [ratio, sizes] of Object.entries(SIZES_BY_RATIO)) {
  for (const resolution of RESOLUTION_KEYS) {
    PRESET_BY_SIZE.set(sizes[resolution], { ratio, resolution });
  }
}

function parseResolution(value: string | undefined): ImageResolutionLabel | null {
  const candidate = value?.trim().toUpperCase() as ImageResolutionLabel | undefined;
  return candidate && RESOLUTION_LABELS.has(candidate) ? candidate : null;
}

export function normalizeImageSize(size: string): string {
  const candidate = size.trim();
  if (candidate === "auto") return candidate;
  return PRESET_BY_SIZE.has(candidate) ? candidate : DEFAULT_IMAGE_SIZE;
}

export function upstreamImageOptions(size: string): { readonly size: string; readonly resolution?: string } {
  const preset = PRESET_BY_SIZE.get(size);
  return preset ? { size: preset.ratio, resolution: preset.resolution } : { size };
}

export function imageResolutionFromSize(size: string, explicitResolution?: string): ImageResolutionLabel {
  const explicit = parseResolution(explicitResolution);
  if (explicit) return explicit;
  return parseResolution(PRESET_BY_SIZE.get(size)?.resolution) ?? "1K";
}

export function imageGenerationResourceKey(resolution: ImageResolutionLabel): string {
  return `image_generation_${resolution.toLowerCase()}`;
}

export function imageSizeForResolution(size: string, resolution: ImageResolutionLabel): string | null {
  const preset = PRESET_BY_SIZE.get(size.trim());
  return preset ? SIZES_BY_RATIO[preset.ratio]?.[resolution.toLowerCase() as ResolutionKey] ?? null : null;
}

export function imageModelResourceKey(model: string, resolution: ImageResolutionLabel): string {
  const modelKey = model.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `image_generation_${modelKey}_${resolution.toLowerCase()}`;
}
