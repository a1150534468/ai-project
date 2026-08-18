import {
  ARTICLE_WORKFLOW_THEME_MAP,
  articleWorkflowMarkdownWithImages,
  renderArticleWorkflowHtml,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";

/**
 * 前端本地确定性渲染：正文 Markdown + 配图清单 + 主题 → 带主题内联 CSS 的 HTML。
 *
 * 与后端 `renderDeterministicArticleBodyHtml` 用的是同一份共享渲染器，保证「预览所见 =
 * 落库所得」零漂移。图片用 imageManifest 里的地址（序列化时已现签），前端直接可显示。
 *
 * auto 主题（或未知主题）返回 null，调用方回落到后端已落库的 bodyHtml。
 */
export function renderArticleWorkflowLocalPreview(args: {
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly galleryMode: ArticleWorkflowGalleryMode;
}): string | null {
  const themeConfig = ARTICLE_WORKFLOW_THEME_MAP[args.theme];
  if (!themeConfig || args.theme === "auto") return null;

  const markdown = articleWorkflowMarkdownWithImages(
    args.bodyMarkdown,
    args.imageManifest.map((image) => ({ slot: image.slot, imageUrl: image.imageUrl })),
  );
  return renderArticleWorkflowHtml(markdown, themeConfig, {
    accent: args.themeColor ?? undefined,
    galleryMode: args.galleryMode,
  });
}

/** 主题卡片缩略渲染用的固定示例正文：一个二级标题 + 一段正文，足够看出主题气质。 */
const THEME_THUMBNAIL_MARKDOWN = "## 标题\n\n正文段落示例，用来看清字号、行距与主色的排版气质。";

/** 渲染一份固定示例正文，作为主题卡片的缩略展示。 */
export function articleWorkflowThemeThumbnail(themeKey: ArticleWorkflowThemeKey): string {
  const theme = ARTICLE_WORKFLOW_THEME_MAP[themeKey];
  if (!theme || themeKey === "auto") return "";
  return renderArticleWorkflowHtml(THEME_THUMBNAIL_MARKDOWN, theme);
}
