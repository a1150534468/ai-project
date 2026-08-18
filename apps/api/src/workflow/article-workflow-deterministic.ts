import {
  articleWorkflowMarkdownWithImages,
  articleWorkflowThemeConfig,
  renderArticleWorkflowHtml,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowThemeKey,
  type GalleryMode,
} from "@ai-assistant/article-workflow";
import { assertArticleWorkflowHtmlFragment, repairArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import { articleWorkflowStableBodyHtml } from "./article-workflow-image-url.js";

/**
 * 非 auto 主题的确定性排版：正文 Markdown + 配图清单 → 带主题内联 CSS 的 HTML 片段。
 *
 * 与 auto（LLM layout）链路的关键差异：
 * - 排版不经过 LLM，效果确定、可复现、主色/字号即时可换；
 * - 图片以内嵌 `<img src="稳定地址">` 落地（复用渲染器原生画廊），不再走
 *   `data-ai-assistant-image-slot` 占位回填——图片更新依赖 bodyMarkdown + imageManifest 重渲。
 *
 * auto 主题（articleWorkflowThemeConfig 返回 null）返回 null，调用方回落到 LLM 链路。
 */
export function renderDeterministicArticleBodyHtml(args: {
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly galleryMode?: GalleryMode;
}): string | null {
  const themeConfig = articleWorkflowThemeConfig(args.theme);
  if (!themeConfig) return null;

  const markdown = articleWorkflowMarkdownWithImages(
    args.bodyMarkdown,
    args.imageManifest.map((image) => ({ slot: image.slot, imageUrl: image.imageUrl })),
  );
  return renderArticleWorkflowHtml(markdown, themeConfig, {
    accent: args.themeColor ?? undefined,
    galleryMode: args.galleryMode,
  });
}

/**
 * 确定性渲染 + 白名单硬校验 + 稳定地址归一，产出可落库的正文 HTML。
 * auto 主题返回 null。三条链（首轮生成 / 重生图 / 补图）共用这一份，
 * 保证「非 auto 正文永远等于 bodyMarkdown + imageManifest 重渲」这一不变量。
 */
export function renderDeterministicArticleBodyHtmlGuarded(args: {
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly galleryMode?: GalleryMode;
}): string | null {
  const rendered = renderDeterministicArticleBodyHtml(args);
  if (rendered === null) return null;
  const guardedHtml = assertArticleWorkflowHtmlFragment({
    html: repairArticleWorkflowHtmlFragment(rendered),
    // 见 materializeHtmlFragmentArticle 的说明：确定性渲染不丢字，expectedVisibleText
    // 取渲染结果自身，只守白名单与注释禁令，避免 extractH2Index 序号 span 的轻微漂移被误判。
    expectedVisibleText: articleWorkflowVisibleTextFromHtml(rendered),
  });
  return articleWorkflowStableBodyHtml(guardedHtml);
}
