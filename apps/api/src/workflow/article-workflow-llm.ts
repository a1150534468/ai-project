import type Anthropic from "@anthropic-ai/sdk";
import type {
  ArticleWorkflowCreationConfig,
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatform,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowSourceFormat,
  ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { jsonrepair } from "jsonrepair";
import type { ZodType, ZodTypeDef } from "zod";
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

/**
 * 模型输出的解析失败要给人话。
 * ZodError.message 本身是一整段 JSON（`[{"code":"too_small",...}]`），
 * 它会一路写进 project.error 并原样显示在失败面板上——运营看不懂，也没法据此操作。
 */
// Input 显式给 unknown：ZodType<T> 会把输入类型也绑成 T，
// 而这些 schema 带 default，输入形状（字段可选）与输出形状并不相同。
function parseModelJson<T>(text: string, schema: ZodType<T, ZodTypeDef, unknown>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(stripCodeFence(text))) as unknown;
  } catch {
    throw new Error("模型返回结构无法解析，请重试");
  }
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  // 字段名留在日志里便于定位，用户只看到「请重试」那句。
  const fields = result.error.issues.map((issue) => issue.path.join(".")).filter(Boolean).join("、");
  console.warn(`[article-workflow] 模型输出不符合 schema: ${fields || "(根对象)"}`);
  throw new Error("模型返回结构不符合要求，请重试");
}

function parsePlanText(text: string): ArticleWorkflowPlan {
  return parseModelJson(text, articleWorkflowPlanSchema);
}

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
  return textFromMessage(response);
}

export function estimateArticleWorkflowReserveUnits(args: {
  readonly sourceText: string;
  readonly creationConfig?: ArticleWorkflowCreationConfig;
  readonly currentHtml?: string;
  readonly currentCaption?: string;
  readonly instruction?: string;
}): number {
  return Math.max(
    1000,
    args.sourceText.length
      + (args.creationConfig ? JSON.stringify(args.creationConfig).length : 0)
      + (args.currentHtml?.length ?? 0)
      + (args.currentCaption?.length ?? 0)
      + (args.instruction?.length ?? 0),
  );
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
  return parsePlanText(text);
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
  return parseModelJson(text, articleWorkflowCaptionPlanSchema);
}

export async function renderArticleWorkflowBodyHtml(args: {
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly bodyMarkdown: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
}): Promise<string> {
  return stripCodeFence(await callLlmText({
    llm: args.llm,
    model: args.model,
    system: buildArticleWorkflowLayoutSystemPrompt({
      theme: args.theme,
      themeColor: args.themeColor ?? undefined,
    }),
    user: buildArticleWorkflowLayoutUserPrompt({
      bodyMarkdown: args.bodyMarkdown,
      imageManifest: args.imageManifest,
    }),
  }));
}
