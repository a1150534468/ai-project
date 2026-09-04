import type {
  ArticleWorkflowCreationConfig,
  ArticleWorkflowCreationMode,
  ArticleWorkflowGalleryMode,
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatform,
  ArticleWorkflowProjectStatus,
  ArticleWorkflowSourceFormat,
  ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { request } from "./http";

export interface ArticleWorkflowProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly creationMode: ArticleWorkflowCreationMode;
  readonly platform: ArticleWorkflowPlatform;
  /** 存量项目没有批次，为 null */
  readonly batchId: string | null;
  readonly theme: ArticleWorkflowThemeKey;
  readonly themeColor: string | null;
  readonly galleryMode: ArticleWorkflowGalleryMode;
  readonly status: ArticleWorkflowProjectStatus;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArticleWorkflowProject extends ArticleWorkflowProjectSummary {
  readonly creationConfig: ArticleWorkflowCreationConfig;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly bodyHtml: string;
  /** 公众号正文 Markdown：确定性主题换肤的本地渲染输入；auto 主题为空串 */
  readonly bodyMarkdown: string;
  /** caption 平台的正文文案；公众号为空串 */
  readonly captionText: string;
  readonly tags: readonly string[];
  readonly imageManifestJson: readonly ArticleWorkflowImageAsset[];
}

export interface ArticleWorkflowBatch {
  readonly batchId: string;
  readonly projects: readonly ArticleWorkflowProject[];
}

type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

function requestArticleWorkflow<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method: RequestMethod;
  readonly fallback: string;
  readonly body?: unknown;
}): Promise<T> {
  return request<T>(args.path, {
    method: args.method,
    token: args.token,
    body: args.body,
    fallback: args.fallback,
  });
}

export function createArticleWorkflowProject(
  token: string,
  body: {
    readonly creationMode: ArticleWorkflowCreationMode;
    readonly creationConfig: ArticleWorkflowCreationConfig;
    readonly sourceFormat: ArticleWorkflowSourceFormat;
    readonly sourceText: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly platforms: readonly ArticleWorkflowPlatform[];
    readonly generateImages: boolean;
    readonly theme: ArticleWorkflowThemeKey;
    readonly themeColor: string | null;
    readonly galleryMode: ArticleWorkflowGalleryMode;
  },
): Promise<{
  readonly batchId: string;
  readonly projects: readonly { readonly projectId: string; readonly platform: ArticleWorkflowPlatform }[];
  readonly projectId: string;
}> {
  return requestArticleWorkflow({
    token,
    path: "/api/workflow/article-workflow",
    method: "POST",
    fallback: "创建图文项目失败",
    body,
  });
}

export function generateArticleWorkflowImages(
  token: string,
  projectId: string,
): Promise<{ readonly projectId: string; readonly queued: boolean }> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}/images/generate`,
    method: "POST",
    fallback: "生成配图失败",
  });
}

export function getArticleWorkflowBatch(token: string, batchId: string): Promise<ArticleWorkflowBatch> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/batch/${encodeURIComponent(batchId)}`,
    method: "GET",
    fallback: "获取图文批次失败",
  });
}

export function listArticleWorkflowHistory(token: string): Promise<readonly ArticleWorkflowProjectSummary[]> {
  return requestArticleWorkflow({
    token,
    path: "/api/workflow/article-workflow/history",
    method: "GET",
    fallback: "获取历史项目失败",
  });
}

export function getArticleWorkflowProject(token: string, projectId: string): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}`,
    method: "GET",
    fallback: "获取图文项目失败",
  });
}

export function deleteArticleWorkflowProject(
  token: string,
  projectId: string,
): Promise<{ readonly deleted: number; readonly batchId: string | null }> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}`,
    method: "DELETE",
    fallback: "删除图文项目失败",
  });
}

/** 保存请求的形状由项目平台的 outputKind 决定，后端按平台选校验分支 */
export type UpdateArticleWorkflowProjectBody =
  | { readonly title: string; readonly summary: string; readonly bodyHtml: string }
  | {
      readonly title: string;
      readonly summary?: string;
      readonly captionText: string;
      readonly tags: readonly string[];
    };

export function updateArticleWorkflowProject(
  token: string,
  projectId: string,
  body: UpdateArticleWorkflowProjectBody,
): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}`,
    method: "PATCH",
    fallback: "保存图文项目失败",
    body,
  });
}

/**
 * 用户点重试：只对 failed 行有效，后端拿库里存的 sourceText 重跑首轮生成，无请求体。
 * 与 rewrite 分开——rewrite 要求已有成品可改，重试面对的是没有成品的那一行。
 */
export function retryArticleWorkflowProject(token: string, projectId: string): Promise<{ projectId: string }> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}/retry`,
    method: "POST",
    fallback: "重新生成失败",
  });
}

export function rewriteArticleWorkflowProject(
  token: string,
  projectId: string,
  body: {
    readonly instruction: string;
    readonly generationMode?: ArticleWorkflowGenerationMode;
    readonly regenerateImages?: boolean;
  },
): Promise<{ projectId: string }> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}/rewrite`,
    method: "POST",
    fallback: "AI 改稿失败",
    body,
  });
}

export function regenerateArticleWorkflowImage(
  token: string,
  projectId: string,
  slot: string,
  body: { readonly promptOverride?: string },
): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}/images/${encodeURIComponent(slot)}/regenerate`,
    method: "POST",
    fallback: "重生图片失败",
    body,
  });
}

/** 确定性主题换肤：后端按 bodyMarkdown + 新主题重渲正文，返回更新后的项目。 */
export function applyArticleWorkflowTheme(
  token: string,
  projectId: string,
  body: {
    readonly theme: ArticleWorkflowThemeKey;
    readonly themeColor: string | null;
    readonly galleryMode: ArticleWorkflowGalleryMode;
  },
): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}/theme`,
    method: "PATCH",
    fallback: "应用主题失败",
    body,
  });
}
