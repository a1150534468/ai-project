import { z } from "zod";

export const COMIC_WORKFLOW_STAGES = ["script", "assets", "storyboard", "render"] as const;
export type ComicStage = typeof COMIC_WORKFLOW_STAGES[number];

export const COMIC_ASSET_TYPES = ["character", "scene", "prop", "style"] as const;
export type ComicAssetType = typeof COMIC_ASSET_TYPES[number];

export const COMIC_SCRIPT_SOURCES = ["manual", "generated", "imported"] as const;
export type ComicScriptSource = typeof COMIC_SCRIPT_SOURCES[number];

export const COMIC_VIDEO_STATUSES = ["idle", "queued", "processing", "succeeded", "failed"] as const;
export type ComicVideoStatus = typeof COMIC_VIDEO_STATUSES[number];

export const comicStageSchema = z.enum(COMIC_WORKFLOW_STAGES);
export const comicAssetTypeSchema = z.enum(COMIC_ASSET_TYPES);
export const comicScriptSourceSchema = z.enum(COMIC_SCRIPT_SOURCES);
export const comicVideoStatusSchema = z.enum(COMIC_VIDEO_STATUSES);

export function nextComicWorkflowStage(stage: ComicStage): ComicStage {
  const index = COMIC_WORKFLOW_STAGES.indexOf(stage);
  return COMIC_WORKFLOW_STAGES[Math.min(index + 1, COMIC_WORKFLOW_STAGES.length - 1)] ?? "render";
}

export function normalizeComicAssetIds(assetIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const assetId of assetIds) {
    const trimmed = assetId.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
