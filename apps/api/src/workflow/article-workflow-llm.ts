import type Anthropic from "@anthropic-ai/sdk";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatform,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { jsonrepair } from "jsonrepair";
import type { ArticleWorkflowCaptionPlan, ArticleWorkflowPlan } from "./article-workflow-schema.js";
import { articleWorkflowCaptionPlanSchema, articleWorkflowPlanSchema } from "./article-workflow-schema.js";
import {
  ARTICLE_MAX_OUTPUT_TOKENS,
  ARTICLE_TIMEOUT_MS,
  type LlmClientLike,
} from "./article-workflow-shared.js";
import {
  buildArticleWorkflowCaptionSystemPrompt,
  buildArticleWorkflowCaptionUserPrompt,
  buildArticleWorkflowLayoutSystemPrompt,
  buildArticleWorkflowLayoutUserPrompt,
  buildArticleWorkflowPlanSystemPrompt,
  buildArticleWorkflowPlanUserPrompt,
} from "./article-workflow-prompt.js";

function normalizeMessage(raw: unknown): readonly Anthropic.ContentBlock[] {
  const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("模型返回结构无法解析");
  }

  const candidate = parsed as {
    readonly content?: unknown;
    readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown }; readonly text?: unknown }>;
  };

  if (Array.isArray(candidate.content)) return candidate.content as readonly Anthropic.ContentBlock[];
  if (typeof candidate.content === "string") {
    return [{ type: "text", text: candidate.content } as Anthropic.TextBlock];
  }

  const choiceText = candidate.choices
    ?.map((choice) => {
      if (typeof choice.message?.content === "string") return choice.message.content;
      if (typeof choice.text === "string") return choice.text;
      return "";
    })
    .join("")
    .trim();
  if (choiceText) return [{ type: "text", text: choiceText } as Anthropic.TextBlock];
  throw new Error("模型响应缺少 content 字段");
}

function textFromMessage(raw: unknown): string {
  return normalizeMessage(raw)
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```(?:json|html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parsePlanText(text: string): ArticleWorkflowPlan {
  const parsed = JSON.parse(jsonrepair(stripCodeFence(text))) as unknown;
  return articleWorkflowPlanSchema.parse(parsed);
}

async function callLlmText(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly system: string;
  readonly user: string;
}): Promise<string> {
  const response = await args.llm.messages.create({
    model: args.model,
    max_tokens: ARTICLE_MAX_OUTPUT_TOKENS,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
  }, {
    timeout: ARTICLE_TIMEOUT_MS,
  });
  return textFromMessage(response);
}

export function estimateArticleWorkflowReserveUnits(args: {
  readonly sourceText: string;
  readonly currentHtml?: string;
  readonly currentCaption?: string;
  readonly instruction?: string;
}): number {
  return Math.max(
    1000,
    args.sourceText.length
      + (args.currentHtml?.length ?? 0)
      + (args.currentCaption?.length ?? 0)
      + (args.instruction?.length ?? 0),
  );
}

export async function generateArticleWorkflowPlan(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly currentHtml?: string;
  readonly instruction?: string;
}): Promise<ArticleWorkflowPlan> {
  const text = await callLlmText({
    llm: args.llm,
    model: args.model,
    system: buildArticleWorkflowPlanSystemPrompt(args.generationMode),
    user: buildArticleWorkflowPlanUserPrompt({
      sourceFormat: args.sourceFormat,
      sourceText: args.sourceText,
      currentHtml: args.currentHtml,
      instruction: args.instruction,
    }),
  });
  return parsePlanText(text);
}

/** caption 平台的单次 LLM 调用；返回未归一化的计划，裁剪交给 normalizeArticleWorkflowCaptionPlan。 */
export async function generateArticleWorkflowCaptionPlan(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly platform: ArticleWorkflowPlatform;
  readonly config: ArticleWorkflowPlatformConfig;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentCaption?: string;
  readonly instruction?: string;
}): Promise<ArticleWorkflowCaptionPlan> {
  const text = await callLlmText({
    llm: args.llm,
    model: args.model,
    system: buildArticleWorkflowCaptionSystemPrompt({ platform: args.platform, config: args.config }),
    user: buildArticleWorkflowCaptionUserPrompt({
      sourceFormat: args.sourceFormat,
      sourceText: args.sourceText,
      currentCaption: args.currentCaption,
      instruction: args.instruction,
      config: args.config,
    }),
  });
  const parsed = JSON.parse(jsonrepair(stripCodeFence(text))) as unknown;
  return articleWorkflowCaptionPlanSchema.parse(parsed);
}

export async function renderArticleWorkflowBodyHtml(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}): Promise<string> {
  return stripCodeFence(await callLlmText({
    llm: args.llm,
    model: args.model,
    system: buildArticleWorkflowLayoutSystemPrompt(),
    user: buildArticleWorkflowLayoutUserPrompt({
      bodyMarkdown: args.bodyMarkdown,
      imageManifest: args.imageManifest,
    }),
  }));
}
