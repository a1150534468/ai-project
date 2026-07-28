import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  ARTICLE_WORKFLOW_PLATFORM_CONFIGS,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatform,
} from "@ai-assistant/article-workflow";

export const DEFAULT_ARTICLE_MODEL = "MiniMax-M3";
export const ARTICLE_MAX_SOURCE_LENGTH = 200_000;
export const ARTICLE_SOURCE_PROMPT_BUDGET = 60_000;
export const ARTICLE_MAX_OUTPUT_TOKENS = 8192;
export const ARTICLE_TIMEOUT_MS = 120_000;
/** 一批最多 3 行（三平台），60 行保证历史里仍有 ≥20 个批次 */
export const ARTICLE_HISTORY_LIMIT = 60;
/** 公众号尺寸的兼容别名，真实取值以平台配置为准 */
export const ARTICLE_COVER_IMAGE_SIZE = ARTICLE_WORKFLOW_PLATFORM_CONFIGS.wechat.coverSize;
export const ARTICLE_INLINE_IMAGE_SIZE = ARTICLE_WORKFLOW_PLATFORM_CONFIGS.wechat.inlineSize;
export const ARTICLE_IMAGE_BATCH_SIZE = 2;
export const ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY = "article_workflow_text_output";
/** 卡死判定阈值：必须大于单张图片尝试上限（IMAGE_ATTEMPT_TIMEOUT_MS 默认 600s），否则会误杀在跑的项目 */
export const ARTICLE_PROJECT_STALE_MS = 15 * 60_000;

export type FetchLike = typeof fetch;
export type ScheduleTask = (work: () => Promise<void>) => void;

export interface ArticleWorkflowBilling {
  readonly reserveResource: (args: {
    operationId: string;
    userId: string;
    resourceKey: string;
    units: number;
  }) => Promise<{ reserved: number }>;
  readonly settleResource: (args: {
    operationId: string;
    resourceKey: string;
    units: number;
  }) => Promise<{ settled: number }>;
  readonly chargeResource: (args: {
    operationId: string;
    userId: string;
    resourceKey: string;
    units: number;
  }) => Promise<{ charged: number }>;
  readonly refundResource: (operationId: string) => Promise<{ success: boolean }>;
  readonly listResourcePrices?: () => Promise<{
    data: {
      resourceKey: string;
      displayName: string;
      pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
      rate: number;
      perUnits: number;
      enabled: boolean;
    }[];
  }>;
}

export interface LlmClientLike {
  readonly messages: {
    readonly create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ) => Promise<Anthropic.Message>;
  };
}

export interface ArticleWorkflowRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: ArticleWorkflowBilling;
  readonly llm?: LlmClientLike;
  readonly fetchFn?: FetchLike;
  readonly scheduleTask?: ScheduleTask;
  readonly env?: NodeJS.ProcessEnv;
}

export type ArticleProjectRow = NonNullable<
  Awaited<ReturnType<PrismaClient["articleWorkflowProject"]["findFirst"]>>
>;

export interface ArticleWorkflowPersistedProject {
  readonly id: string;
  readonly userId: string;
  readonly sourceFormat: "plain-text" | "markdown";
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly platform: ArticleWorkflowPlatform;
  readonly batchId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly captionText: string;
  readonly tags: readonly string[];
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly status: string;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly error: string | null;
}

export function scheduledRunner(app: FastifyInstance): ScheduleTask {
  return (work) => {
    void work().catch((error) => app.log.error(error));
  };
}

export function isBusyArticleProjectStatus(status: string | null | undefined): boolean {
  return status === "generating" || status === "revising";
}

export function canRecoverArticleProject(status: string | null | undefined): boolean {
  return status === "ready" || status === "failed";
}
