import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { ApiError, readErrorMessage } from "./apiError";

export interface ArticleWorkflowProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly status: ArticleWorkflowProjectStatus;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArticleWorkflowProject extends ArticleWorkflowProjectSummary {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly bodyHtml: string;
  readonly imageManifestJson: readonly ArticleWorkflowImageAsset[];
}

export interface ArticleWorkflowPricingRow {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
}

export interface ArticleWorkflowPricing {
  readonly text: ArticleWorkflowPricingRow;
  readonly image1k: ArticleWorkflowPricingRow;
  readonly maxImages: number;
}

type WorkflowResponse<T> = { readonly data: T };
type RequestMethod = "GET" | "POST" | "PATCH";

async function requestArticleWorkflow<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method: RequestMethod;
  readonly fallback: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetch(args.path, {
    method: args.method,
    headers: args.body === undefined
      ? { authorization: `Bearer ${args.token}` }
      : { "content-type": "application/json", authorization: `Bearer ${args.token}` },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, args.fallback), response.status);
  const payload = (await response.json()) as WorkflowResponse<T>;
  return payload.data;
}

export function createArticleWorkflowProject(token: string, body: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
}): Promise<{ projectId: string }> {
  return requestArticleWorkflow({
    token,
    path: "/api/workflow/article-workflow",
    method: "POST",
    fallback: "创建公众号图文项目失败",
    body,
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

export function getArticleWorkflowPricing(token: string): Promise<ArticleWorkflowPricing> {
  return requestArticleWorkflow({
    token,
    path: "/api/workflow/article-workflow/pricing",
    method: "GET",
    fallback: "获取公众号图文计价失败",
  });
}

export function getArticleWorkflowProject(token: string, projectId: string): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}`,
    method: "GET",
    fallback: "获取公众号图文项目失败",
  });
}

export function updateArticleWorkflowProject(token: string, projectId: string, body: {
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
}): Promise<ArticleWorkflowProject> {
  return requestArticleWorkflow({
    token,
    path: `/api/workflow/article-workflow/${encodeURIComponent(projectId)}`,
    method: "PATCH",
    fallback: "保存公众号图文项目失败",
    body,
  });
}

export function rewriteArticleWorkflowProject(token: string, projectId: string, body: {
  readonly instruction: string;
  readonly generationMode?: ArticleWorkflowGenerationMode;
  readonly regenerateImages?: boolean;
}): Promise<{ projectId: string }> {
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
