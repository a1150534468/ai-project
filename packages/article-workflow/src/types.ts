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

export const ARTICLE_WORKFLOW_CREATION_MODES = [
  "source",
  "topic",
] as const;

export const ARTICLE_WORKFLOW_STYLE_MODES = [
  "preset",
  "custom",
  "imitate",
] as const;

export const ARTICLE_WORKFLOW_TOPIC_PRESETS = [
  "general",
  "experience",
  "recommendation",
  "tutorial",
  "opinion",
  "healing",
] as const;

export const ARTICLE_WORKFLOW_THEMES = [
  "auto",
  "literary",
  "swiss-index",
  "night-film",
  "white-cube",
  "pixel-quest",
  "velocity-report",
  "mobai",
  "klein",
  "xuanzhi",
  "morandi-green",
  "midnight-gold",
  "cream-orange",
  "mint-soda",
  "brick-industry",
  "mori-journal",
  "fleet-street",
  "blueprint",
  "peach-soda",
  "mono-editorial",
  "lemon-sea",
  "wisteria",
  "hk-neon",
  "nordic",
  "latte",
  "cyan-scape",
  "candy-pop",
] as const;

export const ARTICLE_WORKFLOW_PLATFORMS = [
  "wechat",
  "xiaohongshu",
  "douyin",
] as const;

export const ARTICLE_WORKFLOW_OUTPUT_KINDS = [
  "html-fragment",
  "caption",
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
export type ArticleWorkflowCreationMode = typeof ARTICLE_WORKFLOW_CREATION_MODES[number];
export type ArticleWorkflowStyleMode = typeof ARTICLE_WORKFLOW_STYLE_MODES[number];
export type ArticleWorkflowTopicPreset = typeof ARTICLE_WORKFLOW_TOPIC_PRESETS[number];
export type ArticleWorkflowThemeKey = typeof ARTICLE_WORKFLOW_THEMES[number];
export type ArticleWorkflowImageSlot = typeof ARTICLE_WORKFLOW_IMAGE_SLOTS[number];
export type ArticleWorkflowPlatform = typeof ARTICLE_WORKFLOW_PLATFORMS[number];
export type ArticleWorkflowOutputKind = typeof ARTICLE_WORKFLOW_OUTPUT_KINDS[number];
export type ArticleWorkflowImageRole = "cover" | "inline";

export type ArticleWorkflowTopicStyle =
  | {
      readonly mode: "preset";
      readonly preset: ArticleWorkflowTopicPreset;
    }
  | {
      readonly mode: "custom";
      readonly instruction: string;
    }
  | {
      readonly mode: "imitate";
      readonly referenceText: string;
    };

export type ArticleWorkflowCreationConfig =
  | {
      readonly mode: "source";
      readonly generateImages: boolean;
    }
  | {
      readonly mode: "topic";
      readonly generateImages: boolean;
      readonly topic: string;
      readonly keyPoints: string;
      readonly audience: string;
      readonly avoid: string;
      readonly style: ArticleWorkflowTopicStyle;
    };

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
  /** 产物所属平台，缺省视为公众号（存量文档没有这个字段）。 */
  readonly platform?: ArticleWorkflowPlatform;
  /** caption 平台的正文文案；公众号产物为空。 */
  readonly captionText?: string;
  /** caption 平台的话题标签，不带 # 号。 */
  readonly tags?: readonly string[];
}
