export interface ComicVideoModel {
  readonly id: string;
  readonly label: string;
  readonly resolution: string;
  readonly minDurationSec: number;
  readonly maxDurationSec: number;
  readonly pointsPerSecond: number;
}

export interface ComicVideoCostInput {
  readonly modelId: string;
  readonly durationSec: number;
  readonly shotCount: number;
}

const COMIC_VIDEO_MODELS = [
  {
    id: "seedance-lite",
    label: "Seedance Lite",
    resolution: "720p",
    minDurationSec: 3,
    maxDurationSec: 10,
    pointsPerSecond: 2,
  },
  {
    id: "seedance-pro",
    label: "Seedance Pro",
    resolution: "1080p",
    minDurationSec: 3,
    maxDurationSec: 10,
    pointsPerSecond: 4,
  },
] as const satisfies readonly ComicVideoModel[];

export function listComicVideoModels(): readonly ComicVideoModel[] {
  return COMIC_VIDEO_MODELS;
}

export function findComicVideoModel(modelId: string): ComicVideoModel {
  return COMIC_VIDEO_MODELS.find((model) => model.id === modelId) ?? COMIC_VIDEO_MODELS[0];
}

export function estimateComicVideoCost(input: ComicVideoCostInput): number {
  const model = findComicVideoModel(input.modelId);
  const duration = Math.min(Math.max(input.durationSec, model.minDurationSec), model.maxDurationSec);
  return Math.ceil(duration * model.pointsPerSecond * Math.max(1, input.shotCount) * 1.2);
}
