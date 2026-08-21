export const HUMAN_IMAGE_MODEL = "doubao-seedream-5-0-260128";

export const HUMAN_IMAGE_MODELS = [
  { value: "doubao-seedream-5-0-260128", label: "豆包 Seedream 5.0", supports1K: false, supports4K: true },
  { value: "gpt-image-2", label: "GPT Image 2", supports1K: true, supports4K: false },
] as const;

export const HUMAN_IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
export const HUMAN_IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;

export type HumanImageModel = (typeof HUMAN_IMAGE_MODELS)[number]["value"];
export type HumanImageAspectRatio = (typeof HUMAN_IMAGE_ASPECT_RATIOS)[number];
export type HumanImageResolution = (typeof HUMAN_IMAGE_RESOLUTIONS)[number];

const SIZE_BY_RESOLUTION: Readonly<Record<HumanImageResolution, Readonly<Record<HumanImageAspectRatio, string>>>> = {
  "1K": {
    "1:1": "1024x1024",
    "3:4": "864x1152",
    "4:3": "1152x864",
    "9:16": "800x1424",
    "16:9": "1424x800",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:4": "1728x2304",
    "4:3": "2304x1728",
    "9:16": "1600x2848",
    "16:9": "2848x1600",
  },
  "4K": {
    "1:1": "4096x4096",
    "3:4": "3520x4704",
    "4:3": "4704x3520",
    "9:16": "3040x5504",
    "16:9": "5504x3040",
  },
};

export function humanImageOutputSize(resolution: HumanImageResolution, aspectRatio: HumanImageAspectRatio): string {
  return SIZE_BY_RESOLUTION[resolution][aspectRatio];
}

export function humanImageModelSupports(model: HumanImageModel, resolution: HumanImageResolution): boolean {
  const option = HUMAN_IMAGE_MODELS.find((item) => item.value === model);
  if (!option) return false;
  if (resolution === "1K") return option.supports1K;
  if (resolution === "4K") return option.supports4K;
  return true;
}
