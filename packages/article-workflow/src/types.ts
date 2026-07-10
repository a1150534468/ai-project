export const ARTICLE_WORKFLOW_PROJECT_STATUSES = [
  "draft",
  "generating",
  "revising",
  "ready",
  "failed",
] as const;

export const ARTICLE_WORKFLOW_SOURCE_FORMATS = [
  "plain-text",
  "markdown",
] as const;

export const ARTICLE_WORKFLOW_GENERATION_MODES = [
  "preserve-text",
  "polish-text",
] as const;

export const ARTICLE_WORKFLOW_IMAGE_SLOTS = [
  "cover",
  "inline-1",
  "inline-2",
  "inline-3",
  "inline-4",
] as const;

export type ArticleWorkflowProjectStatus = typeof ARTICLE_WORKFLOW_PROJECT_STATUSES[number];
export type ArticleWorkflowSourceFormat = typeof ARTICLE_WORKFLOW_SOURCE_FORMATS[number];
export type ArticleWorkflowGenerationMode = typeof ARTICLE_WORKFLOW_GENERATION_MODES[number];
export type ArticleWorkflowImageSlot = typeof ARTICLE_WORKFLOW_IMAGE_SLOTS[number];
export type ArticleWorkflowImageRole = "cover" | "inline";

export interface ArticleWorkflowImageAsset {
  readonly slot: ArticleWorkflowImageSlot;
  readonly role: ArticleWorkflowImageRole;
  readonly assetId: string | null;
  readonly imageUrl: string;
  readonly thumbnailUrl: string;
  readonly alt: string;
  readonly caption: string;
  readonly prompt: string;
}

export interface ArticleWorkflowDocument {
  readonly version: 1;
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}
