const IMAGE_FALLBACK_SIZE = "1024x1024";

const IMAGE_UPSTREAM_PRESETS: Readonly<Record<string, { readonly ratio: string; readonly resolution: string }>> = {
  "1024x1024": { ratio: "1:1", resolution: "1k" },
  "2048x2048": { ratio: "1:1", resolution: "2k" },
  "2880x2880": { ratio: "1:1", resolution: "4k" },
  "1024x768": { ratio: "4:3", resolution: "1k" },
  "2048x1536": { ratio: "4:3", resolution: "2k" },
  "3312x2480": { ratio: "4:3", resolution: "4k" },
  "768x1024": { ratio: "3:4", resolution: "1k" },
  "1536x2048": { ratio: "3:4", resolution: "2k" },
  "2480x3312": { ratio: "3:4", resolution: "4k" },
  "1536x1024": { ratio: "3:2", resolution: "1k" },
  "2048x1360": { ratio: "3:2", resolution: "2k" },
  "3520x2336": { ratio: "3:2", resolution: "4k" },
  "1024x1536": { ratio: "2:3", resolution: "1k" },
  "1360x2048": { ratio: "2:3", resolution: "2k" },
  "2336x3520": { ratio: "2:3", resolution: "4k" },
  "1536x864": { ratio: "16:9", resolution: "1k" },
  "2048x1152": { ratio: "16:9", resolution: "2k" },
  "3840x2160": { ratio: "16:9", resolution: "4k" },
  "864x1536": { ratio: "9:16", resolution: "1k" },
  "1152x2048": { ratio: "9:16", resolution: "2k" },
  "2160x3840": { ratio: "9:16", resolution: "4k" },
  "2016x864": { ratio: "21:9", resolution: "1k" },
  "2688x1152": { ratio: "21:9", resolution: "2k" },
  "3840x1648": { ratio: "21:9", resolution: "4k" },
};

export type ImageResolutionLabel = "1K" | "2K" | "4K";

const IMAGE_RESOURCE_KEY_BY_RESOLUTION: Readonly<Record<ImageResolutionLabel, string>> = {
  "1K": "image_generation_1k",
  "2K": "image_generation_2k",
  "4K": "image_generation_4k",
};

function normalizeResolution(value: string | undefined): ImageResolutionLabel | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "1K" || normalized === "2K" || normalized === "4K" ? normalized : null;
}

export function normalizeImageSize(size: string): string {
  const trimmed = size.trim();
  if (trimmed === "auto") return trimmed;
  return IMAGE_UPSTREAM_PRESETS[trimmed] ? trimmed : IMAGE_FALLBACK_SIZE;
}

export function upstreamImageOptions(size: string): { readonly size: string; readonly resolution?: string } {
  const preset = IMAGE_UPSTREAM_PRESETS[size];
  if (preset) return { size: preset.ratio, resolution: preset.resolution };
  return { size };
}

export function imageResolutionFromSize(size: string, explicitResolution?: string): ImageResolutionLabel {
  const requested = normalizeResolution(explicitResolution);
  if (requested) return requested;
  const preset = IMAGE_UPSTREAM_PRESETS[size];
  return normalizeResolution(preset?.resolution) ?? "1K";
}

export function imageGenerationResourceKey(resolution: ImageResolutionLabel): string {
  return IMAGE_RESOURCE_KEY_BY_RESOLUTION[resolution];
}
