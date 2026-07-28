import {
  ARTICLE_WORKFLOW_PLATFORMS,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowOutputKind,
  type ArticleWorkflowPlatform,
} from "./types.js";

/**
 * 单个平台的产物形态与硬约束。
 *
 * 这是多平台图文工作流的唯一事实来源：服务端取尺寸/字数上限、前端取展示名与计数上限，
 * 都必须读这里，不要在各自模块里再抄一份常量。
 */
export interface ArticleWorkflowPlatformConfig {
  readonly platform: ArticleWorkflowPlatform;
  readonly label: string;
  readonly outputKind: ArticleWorkflowOutputKind;
  /** 封面图尺寸，取值必须是 IMAGE_UPSTREAM_PRESETS 里已有的 1k 预设。 */
  readonly coverSize: string;
  /** 内页配图尺寸。 */
  readonly inlineSize: string;
  readonly maxImages: number;
  readonly titleMaxLength: number;
  /** caption 平台的正文字数上限；html-fragment 平台不适用，取 0。 */
  readonly captionMaxLength: number;
  readonly minTags: number;
  readonly maxTags: number;
  readonly allowedModes: readonly ArticleWorkflowGenerationMode[];
}

export const ARTICLE_WORKFLOW_PLATFORM_CONFIGS: Readonly<
  Record<ArticleWorkflowPlatform, ArticleWorkflowPlatformConfig>
> = {
  wechat: {
    platform: "wechat",
    label: "微信公众号",
    outputKind: "html-fragment",
    coverSize: "1536x864",
    inlineSize: "1024x768",
    maxImages: 5,
    titleMaxLength: 120,
    captionMaxLength: 0,
    minTags: 0,
    maxTags: 0,
    allowedModes: ["preserve-text", "polish-text"],
  },
  xiaohongshu: {
    platform: "xiaohongshu",
    label: "小红书",
    outputKind: "caption",
    coverSize: "768x1024",
    inlineSize: "768x1024",
    maxImages: 5,
    // 20 字是小红书标题的平台硬限制。
    titleMaxLength: 20,
    captionMaxLength: 1000,
    minTags: 3,
    maxTags: 6,
    allowedModes: ["polish-text"],
  },
  douyin: {
    platform: "douyin",
    label: "抖音",
    outputKind: "caption",
    coverSize: "864x1536",
    inlineSize: "864x1536",
    maxImages: 5,
    // 抖音允许更长，30 字是可读性取值。
    titleMaxLength: 30,
    captionMaxLength: 600,
    minTags: 3,
    maxTags: 5,
    allowedModes: ["polish-text"],
  },
};

function isArticleWorkflowPlatform(value: unknown): value is ArticleWorkflowPlatform {
  return typeof value === "string"
    && (ARTICLE_WORKFLOW_PLATFORMS as readonly string[]).includes(value);
}

/** 未知平台一律回落公众号，保证存量数据与旧客户端不炸。 */
export function articleWorkflowPlatformConfig(platform: unknown): ArticleWorkflowPlatformConfig {
  return isArticleWorkflowPlatform(platform)
    ? ARTICLE_WORKFLOW_PLATFORM_CONFIGS[platform]
    : ARTICLE_WORKFLOW_PLATFORM_CONFIGS.wechat;
}

export function isCaptionPlatform(platform: unknown): boolean {
  return articleWorkflowPlatformConfig(platform).outputKind === "caption";
}

/**
 * 把用户请求的生成模式裁定为该平台真正支持的模式。
 *
 * preserve-text（保留原文排版）只对公众号有意义，caption 平台请求它时静默降级为
 * polish-text，而不是报错——用户在平台页签间切换时不该被 400 拦住。
 */
export function resolveArticleWorkflowMode(
  platform: unknown,
  requested: ArticleWorkflowGenerationMode,
): ArticleWorkflowGenerationMode {
  const config = articleWorkflowPlatformConfig(platform);
  return config.allowedModes.includes(requested) ? requested : config.allowedModes[0];
}
