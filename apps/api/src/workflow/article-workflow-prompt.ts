import {
  ARTICLE_WORKFLOW_HTML_ATTRS,
  ARTICLE_WORKFLOW_HTML_TAGS,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowPlatformConfig,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { ARTICLE_SOURCE_PROMPT_BUDGET } from "./article-workflow-shared.js";

function sourceFormatHint(sourceFormat: ArticleWorkflowSourceFormat): string {
  return sourceFormat === "markdown"
    ? "输入素材是 Markdown。请理解其中的标题、列表、引用与段落结构，但不要把 Markdown 标记当成可见文字。"
    : "输入素材是纯文本。请自行识别标题、段落、列表和节奏。";
}

function generationModeHint(mode: ArticleWorkflowGenerationMode): string {
  return mode === "preserve-text"
    ? [
        "你只能识别标题、摘要、正文与配图需求。正文可见文字必须保持原样，不能改写、增删、总结或重排。",
        // title 是元数据而不是正文可见文字，所以「保持原样」不适用于它。
        // 早先这句写成「如果素材里有标题…」，遇到无独立标题的纯正文素材，
        // 模型会守着「不增删」交回空 title，整单卡在 schema 校验上（默认就是这个模式）。
        "title 是文章元数据，不属于正文可见文字：素材自带标题就原样取用；没有标题时，从正文里提炼一个，不要编造素材里没有的事实。",
        "提炼出的标题不要再重复放进 bodyMarkdown。",
      ].join("\n")
    : "你可以先润色和重写，再输出更适合公众号发布的 bodyMarkdown。";
}

/**
 * html-fragment（公众号）链路的计划提示词。
 * caption 平台走 buildArticleWorkflowCaptionSystemPrompt，不共用这一套。
 */
export function buildArticleWorkflowPlanSystemPrompt(mode: ArticleWorkflowGenerationMode): string {
  return [
    "你是资深微信公众号编辑与电商内容策划。",
    "你的任务是把素材整理成一份图文生成计划。",
    "只输出 JSON，不要输出解释，不要输出 Markdown 代码围栏。",
    generationModeHint(mode),
    // 结构示例里的空串曾被原样抄回（title:"" summary:""），改成占位说明。
    '输出结构固定为 {"title":"<标题>","summary":"<一句话摘要>","bodyMarkdown":"<正文>","images":[...]}。',
    "title 必须非空。summary 与 title 要单独输出，不要把标题再塞回 bodyMarkdown 的正文里。",
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

function platformToneHints(platform: ArticleWorkflowPlatform): readonly string[] {
  if (platform === "xiaohongshu") {
    return [
      "用第一人称口语写，像真实用户分享亲身体验，不要写成新闻稿或广告稿。",
      "适度用 emoji 分段，但每段最多一个，不要堆砌。",
      "结尾用一句自然的话引导互动（提问、求推荐、欢迎评论都可以）。",
      "不要浮夸承诺，不要“最”“第一”“绝对”这类极限词，不要医疗功效断言。",
    ];
  }
  if (platform === "douyin") {
    return [
      "前两行必须先抓住注意力，把最有信息量或最反常识的一点放最前面。",
      "句子要短，读起来像口播，避免长定语和书面语。",
      "话题标签放在文案最后。",
      "不要浮夸承诺，不要极限词。",
    ];
  }
  return [];
}

/** caption 链路（小红书 / 抖音）的计划提示词。 */
export function buildArticleWorkflowCaptionSystemPrompt(args: {
  readonly platform: ArticleWorkflowPlatform;
  readonly config: ArticleWorkflowPlatformConfig;
}): string {
  const { config } = args;
  return [
    `你是资深${config.label}内容运营，擅长把素材改写成高完成度的${config.label}笔记。`,
    "你的任务是输出一份图文笔记生成计划。",
    "只输出 JSON，不要输出解释，不要输出 Markdown 代码围栏。",
    '输出结构固定为 {"title":"","captionText":"","tags":[],"images":[...]}。',
    `title 不超过 ${config.titleMaxLength} 个字。`,
    `captionText 是笔记正文，不超过 ${config.captionMaxLength} 个字，可以用换行分段。`,
    `tags 给 ${config.minTags} 到 ${config.maxTags} 个话题标签，只写标签词本身，不要带 # 号。`,
    `images 至少 1 张，最多 ${config.maxImages} 张；第一张必须是封面图。`,
    "images[n].slot 只能按顺序使用：cover、inline-1、inline-2、inline-3、inline-4。",
    'images[n].role 只能是 "cover" 或 "inline"。',
    "每张图都要给出简洁准确的 alt、空 caption、以及具体的 prompt。",
    "prompt 要描述真实画面，不要海报大字，不要文字水印，不要在画面里写字。",
    "captionText 里不要包含 HTML 标签，也不要写 Markdown 标记。",
    ...platformToneHints(args.platform),
  ].join("\n");
}

export function buildArticleWorkflowCaptionUserPrompt(args: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentCaption?: string;
  readonly instruction?: string;
  readonly config: ArticleWorkflowPlatformConfig;
}): string {
  return [
    sourceFormatHint(args.sourceFormat),
    `目标平台：${args.config.label}。`,
    "",
    "素材内容：",
    args.sourceText.slice(0, ARTICLE_SOURCE_PROMPT_BUDGET),
    args.currentCaption ? `\n当前已生成的文案：\n${args.currentCaption.slice(0, ARTICLE_SOURCE_PROMPT_BUDGET)}` : "",
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
    // 这份清单必须逐个列出来。早先只写「WeChat-safe article tags only」，模型给了完全合理的
    // <h2>，服务端 guard 直接判整单失败——配图钱都花完了才失败。约束要可执行，不能靠模型猜。
    `The ONLY tags you may output are: ${ARTICLE_WORKFLOW_HTML_TAGS.join(", ")}. Any other tag will be rejected.`,
    `The ONLY attributes you may output are: ${ARTICLE_WORKFLOW_HTML_ATTRS.join(", ")}.`,
    "Avoid risky layout techniques such as position, float, z-index, transform, filter, negative margins, or fixed heights.",
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
