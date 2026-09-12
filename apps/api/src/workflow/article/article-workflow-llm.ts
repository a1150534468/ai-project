import type {
  ArticleWorkflowCreationConfig,
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatform,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowCaptionPlan, ArticleWorkflowPlan } from "./article-workflow-schema.js";
import { articleWorkflowCaptionPlanSchema, articleWorkflowPlanSchema } from "./article-workflow-schema.js";
import {
  ARTICLE_MAX_OUTPUT_TOKENS,
  ARTICLE_TIMEOUT_MS,
  type LlmClientLike,
} from "./article-workflow-shared.js";
import { withArticleWorkflowRetry } from "./article-workflow-retry.js";
import {
  buildArticleWorkflowCaptionSystemPrompt,
  buildArticleWorkflowCaptionUserPrompt,
  buildArticleWorkflowLayoutSystemPrompt,
  buildArticleWorkflowLayoutUserPrompt,
  buildArticleWorkflowPlanSystemPrompt,
  buildArticleWorkflowPlanUserPrompt,
} from "./article-workflow-prompt.js";
import { articleWorkflowTextFromResponse, parseArticleWorkflowJson, stripArticleWorkflowCodeFence } from "./article-workflow-llm-response.js";

async function callLlmText(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly system: string;
  readonly user: string;
}): Promise<string> {
  // 抖动型失败（超时/限流/5xx）在这里就地重试，三条 LLM 调用共用这一个落点
  const response = await withArticleWorkflowRetry({
    work: () => args.llm.messages.create({
      model: args.model,
      max_tokens: ARTICLE_MAX_OUTPUT_TOKENS,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    }, {
      timeout: ARTICLE_TIMEOUT_MS,
    }),
  });
  return articleWorkflowTextFromResponse(response);
}

export async function generateArticleWorkflowPlan(args: {
  readonly creationConfig?: ArticleWorkflowCreationConfig;
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
      creationConfig: args.creationConfig,
      sourceFormat: args.sourceFormat,
      sourceText: args.sourceText,
      currentHtml: args.currentHtml,
      instruction: args.instruction,
    }),
  });
  return parseArticleWorkflowJson(text, articleWorkflowPlanSchema);
}

/** caption 平台的单次 LLM 调用；返回未归一化的计划，裁剪交给 normalizeArticleWorkflowCaptionPlan。 */
export async function generateArticleWorkflowCaptionPlan(args: {
  readonly creationConfig?: ArticleWorkflowCreationConfig;
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
      creationConfig: args.creationConfig,
      sourceFormat: args.sourceFormat,
      sourceText: args.sourceText,
      currentCaption: args.currentCaption,
      instruction: args.instruction,
      config: args.config,
    }),
  });
  return parseArticleWorkflowJson(text, articleWorkflowCaptionPlanSchema);
}

export async function renderArticleWorkflowBodyHtml(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}): Promise<string> {
  return stripArticleWorkflowCodeFence(await callLlmText({
    llm: args.llm,
    model: args.model,
    system: buildArticleWorkflowLayoutSystemPrompt(),
    user: buildArticleWorkflowLayoutUserPrompt({
      bodyMarkdown: args.bodyMarkdown,
      imageManifest: args.imageManifest,
    }),
  }));
}
