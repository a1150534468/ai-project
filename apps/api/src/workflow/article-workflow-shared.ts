import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
} from "@ai-assistant/article-workflow";

export const DEFAULT_ARTICLE_MODEL = "MiniMax-M3";
export const ARTICLE_MAX_SOURCE_LENGTH = 200_000;
export const ARTICLE_SOURCE_PROMPT_BUDGET = 60_000;
export const ARTICLE_MAX_OUTPUT_TOKENS = 8192;
export const ARTICLE_TIMEOUT_MS = 120_000;
export const ARTICLE_HISTORY_LIMIT = 20;
export const ARTICLE_COVER_IMAGE_SIZE = "1536x864";
export const ARTICLE_INLINE_IMAGE_SIZE = "1024x768";
export const ARTICLE_IMAGE_BATCH_SIZE = 2;
export const ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY = "article_workflow_text_output";

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
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
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
