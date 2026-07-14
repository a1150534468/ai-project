import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { ARTICLE_SOURCE_PROMPT_BUDGET } from "./article-workflow-shared.js";

function sourceFormatHint(sourceFormat: ArticleWorkflowSourceFormat): string {
  return sourceFormat === "markdown"
    ? "输入素材是 Markdown。请理解其中的标题、列表、引用与段落结构，但不要把 Markdown 标记当成可见文字。"
    : "输入素材是纯文本。请自行识别标题、段落、列表和节奏。";
}

function generationModeHint(mode: ArticleWorkflowGenerationMode): string {
  return mode === "preserve-text"
    ? "你只能识别标题、摘要、正文与配图需求。正文可见文字必须保持原样，不能改写、增删、总结或重排；如果素材里有标题，请单独放进 title，不要再放进 bodyMarkdown。"
    : "你可以先润色和重写，再输出更适合公众号发布的 bodyMarkdown。";
}

export function buildArticleWorkflowPlanSystemPrompt(mode: ArticleWorkflowGenerationMode): string {
  return [
    "你是资深微信公众号编辑与电商内容策划。",
    "你的任务是把素材整理成一份图文生成计划。",
    "只输出 JSON，不要输出解释，不要输出 Markdown 代码围栏。",
    generationModeHint(mode),
    '输出结构固定为 {"title":"","summary":"","bodyMarkdown":"","images":[...]}。',
    "title 和 summary 要单独输出，不要把标题再塞回 bodyMarkdown 的正文里。",
    "images 至少 1 张，最多 5 张；第一张必须是封面图。",
    'images[n].slot 只能按顺序使用：cover、inline-1、inline-2、inline-3、inline-4。',
    'images[n].role 只能是 "cover" 或 "inline"。',
    "每张图都要给出简洁准确的 alt、空 caption、以及具体的 prompt。",
    "prompt 要描述真实画面，不要海报大字，不要文字水印。",
    "bodyMarkdown 中不要包含 HTML 标签。",
    "不要添加解释性文案、徽标文案、角标、口号、脚注或任何素材中不存在的可见文字。",
  ].join("\n");
}

export function buildArticleWorkflowPlanUserPrompt(args: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentHtml?: string;
  readonly instruction?: string;
}): string {
  return [
    sourceFormatHint(args.sourceFormat),
    "",
    "素材内容：",
    args.sourceText.slice(0, ARTICLE_SOURCE_PROMPT_BUDGET),
    args.currentHtml ? `\n当前已生成的 HTML：\n${args.currentHtml.slice(0, ARTICLE_SOURCE_PROMPT_BUDGET)}` : "",
    args.instruction ? `\n用户要求：\n${args.instruction}` : "",
  ].filter(Boolean).join("\n");
}

export function buildArticleWorkflowLayoutSystemPrompt(): string {
  return [
    "You are an expert WeChat official account article layout assistant.",
    "Turn the article into a polished WeChat-ready HTML fragment.",
    "You may improve structure, typography, spacing, borders, backgrounds, and rhythm, but you must preserve all visible article text exactly.",
    "Do not rewrite, summarize, expand, compress, reorder, or add visible content.",
    "Output fragment HTML only. Never output html/head/body/meta/title/link/style/script/comments.",
    "Use strict inline CSS only. Never depend on classes or external stylesheets.",
    "Allowed tags are WeChat-safe article tags only. Avoid risky layout techniques such as position, float, z-index, transform, filter, negative margins, or fixed heights.",
    "Do not add any new visible text, labels, badges, chapter counters, CTA copy, helper copy, footer slogans, or editor artifacts.",
    "The layout must be safe for direct paste into the WeChat official account editor.",
    "Prefer section containers, paragraph rhythm, modest borders/backgrounds, and mobile-friendly spacing.",
    "For every required image slot, output exactly one empty placeholder section like:",
    '<section data-ai-assistant-image-slot="cover"></section>',
    "Do not put visible text inside image placeholder sections.",
    "Do not wrap the answer in Markdown code fences.",
  ].join("\n");
}

export function buildArticleWorkflowLayoutUserPrompt(args: {
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}): string {
  const slots = args.imageManifest.map((image) => {
    return `- ${image.slot}: role=${image.role}, alt=${image.alt || "文章配图"}, prompt=${image.prompt}`;
  }).join("\n");

  return [
    "请把下面这篇文章排成微信公众号可直接粘贴的 HTML fragment。",
    "必须保留 markdown 对应的可见文字完全一致。",
    "请根据文章节奏，自然地放置图片占位 section。",
    "不要新增任何解释性文案、标题角标、脚注、来源说明或按钮文案。",
    "",
    "必需的图片槽位：",
    slots,
    "",
    "文章 Markdown：",
    args.bodyMarkdown.slice(0, ARTICLE_SOURCE_PROMPT_BUDGET),
  ].join("\n");
}
