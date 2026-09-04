import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  ARTICLE_WORKFLOW_PLATFORM_CONFIGS,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowCreationMode,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS, articleWorkflowRetryDelayMs } from "./article-workflow-retry.js";
import { loadImageAttemptTimeoutMs } from "../_shared/image-service.js";
import { imageDispatchWorstWaitMs } from "../_shared/image-dispatch-gate.js";

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
/**
 * 卡死判定的兜底阈值，仅在算不出真实上限时使用。
 * 真实阈值走 {@link articleProjectStaleMs}——它按当前的出图超时与重试预算推导。
 */
export const ARTICLE_PROJECT_STALE_MS = 15 * 60_000;

/**
 * 心跳是 `updatedAt`：runner 每写一次进度就刷新。所以阈值要盖住的不是「整行耗时」，
 * 而是**两次进度写入之间的最长间隔**——即出图的一个批次（ARTICLE_IMAGE_BATCH_SIZE 张并发，
 * onProgress 按批回调）。
 *
 * 一个批次的上限 = 单次尝试超时 × 系统兜底重试次数 + 退避。曾经这里写死 15 分钟、
 * 注释只提「单张尝试上限」，加入重试后实测被 reaper 误判为超时中断（两行卡在 35% 被收尸），
 * 因此改成从同一批常量推导，避免超时或重试预算调整时这里悄悄失配。
 *
 * 每次尝试还要先过共享派发闸门，排队等待不写心跳，所以单次尝试的上限是
 * 「闸门最坏等待 + 尝试超时」；漏掉闸门那一项就又是一次同样的误判收尸。
 */
export function articleProjectStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const attemptMs = loadImageAttemptTimeoutMs(env) + imageDispatchWorstWaitMs(env);
  const backoffMs =
    ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS * articleWorkflowRetryDelayMs(ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS, env);
  // 1.5 倍余量留给下载、入库、S3 上传等批次内的非上游耗时。
  const worstChunkMs = Math.round((attemptMs * ARTICLE_IMAGE_RETRY_MAX_ATTEMPTS + backoffMs) * 1.5);
  return Math.max(ARTICLE_PROJECT_STALE_MS, worstChunkMs);
}

export type FetchLike = typeof fetch;
export type ScheduleTask = (work: () => Promise<void>) => void;

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
  readonly llm?: LlmClientLike;
  readonly fetchFn?: FetchLike;
  readonly scheduleTask?: ScheduleTask;
  readonly env?: NodeJS.ProcessEnv;
  /** 配图取图时从对象存储读字节，测试里替换掉即可脱开 S3 */
  readonly loadImageBlob?: (objectKey: string) => Promise<Buffer>;
}

export type ArticleProjectRow = NonNullable<Awaited<ReturnType<PrismaClient["articleWorkflowProject"]["findFirst"]>>>;

export interface ArticleWorkflowPersistedProject {
  readonly id: string;
  readonly userId: string;
  readonly creationMode: ArticleWorkflowCreationMode;
  readonly creationConfig: ArticleWorkflowCreationConfig;
  readonly sourceFormat: "plain-text" | "markdown";
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly platform: ArticleWorkflowPlatform;
  readonly batchId: string | null;
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly galleryMode: ArticleWorkflowGalleryMode;
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly bodyMarkdown: string;
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

/**
 * 保存只允许发生在已有成品的行上。
 * failed 行不能被 PATCH 救活：前端自动保存会把空编辑器写进去，
 * 顺带把 status 抹成 ready、清掉 error，失败现场就没了。
 */
export function canSaveArticleProject(status: string | null | undefined): boolean {
  return status === "ready";
}
