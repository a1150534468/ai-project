/**
 * 多平台图文工作流的 11 个接口。它们的请求形状是同一个：一个共同前缀 + token + 一句中文兜底文案，
 * 所以按 HTTP 方法各包一层薄壳，下面每个导出函数就只剩「打哪条路径、失败时说什么」。
 *
 * 类型全部来自 `@ai-assistant/article-workflow`（后端与前端共用那一份），请求体尽量从项目本身
 * `Pick<>` 出来 —— 两份定义各改一半是这类镜像文件最容易犯的错。
 */
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

/** 后端只是受理了活儿（首轮生成 / 改稿都在后台跑），前端拿这个 id 去轮询项目状态。 */
export interface ArticleWorkflowJobAccepted {
  readonly projectId: string;
}

/**
 * 建项目的请求体。除 `platforms` / `generateImages` 之外每一项都与项目上的同名字段同型，
 * 所以从 `ArticleWorkflowProject` 挑，不再抄一份。
 *
 * 一次提交按平台生成多篇（每个平台各一个项目），所以这里是复数 `platforms`，项目上才是单数。
 */
export interface CreateArticleWorkflowProjectBody
  extends Pick<
    ArticleWorkflowProject,
    | "creationMode"
    | "creationConfig"
    | "sourceFormat"
    | "sourceText"
    | "generationMode"
    | "theme"
    | "themeColor"
    | "galleryMode"
  > {
  readonly platforms: readonly ArticleWorkflowPlatform[];
  readonly generateImages: boolean;
}

export interface CreateArticleWorkflowProjectResult {
  readonly batchId: string;
  readonly projects: readonly { readonly projectId: string; readonly platform: ArticleWorkflowPlatform }[];
  /** 批次里第一篇的 id：建完直接跳它。 */
  readonly projectId: string;
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

const BASE_PATH = "/api/workflow/article-workflow";

/** 项目级路径。id 是后端给的，仍然编码一次 —— 拼 URL 的地方不赌上游内容。 */
function projectPath(projectId: string, suffix = ""): string {
  return `${BASE_PATH}/${encodeURIComponent(projectId)}${suffix}`;
}

function get<T>(token: string, path: string, fallback: string): Promise<T> {
  return request<T>(path, { method: "GET", token, fallback });
}

/** 不带 body 的 POST（重试、触发生图）也走这里：`body: undefined` 等于不发 body。 */
function post<T>(token: string, path: string, fallback: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", token, fallback, body });
}

function patch<T>(token: string, path: string, fallback: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", token, fallback, body });
}

function remove<T>(token: string, path: string, fallback: string): Promise<T> {
  return request<T>(path, { method: "DELETE", token, fallback });
}

// ── 项目：建 / 读 / 改 / 删 ───────────────────────────────────────────────────

export function createArticleWorkflowProject(
  token: string,
  body: CreateArticleWorkflowProjectBody,
): Promise<CreateArticleWorkflowProjectResult> {
  return post(token, BASE_PATH, "创建图文项目失败", body);
}

export function listArticleWorkflowHistory(token: string): Promise<readonly ArticleWorkflowProjectSummary[]> {
  return get(token, `${BASE_PATH}/history`, "获取历史项目失败");
}

export function getArticleWorkflowBatch(token: string, batchId: string): Promise<ArticleWorkflowBatch> {
  return get(token, `${BASE_PATH}/batch/${encodeURIComponent(batchId)}`, "获取图文批次失败");
}

export function getArticleWorkflowProject(token: string, projectId: string): Promise<ArticleWorkflowProject> {
  return get(token, projectPath(projectId), "获取图文项目失败");
}

export function updateArticleWorkflowProject(
  token: string,
  projectId: string,
  body: UpdateArticleWorkflowProjectBody,
): Promise<ArticleWorkflowProject> {
  return patch(token, projectPath(projectId), "保存图文项目失败", body);
}

export function deleteArticleWorkflowProject(
  token: string,
  projectId: string,
): Promise<{ readonly deleted: number; readonly batchId: string | null }> {
  return remove(token, projectPath(projectId), "删除图文项目失败");
}

// ── 重跑：重试 / 改稿 / 配图 / 换肤 ───────────────────────────────────────────

/**
 * 用户点重试：只对 failed 行有效，后端拿库里存的 sourceText 重跑首轮生成，无请求体。
 * 与 rewrite 分开——rewrite 要求已有成品可改，重试面对的是没有成品的那一行。
 */
export function retryArticleWorkflowProject(token: string, projectId: string): Promise<ArticleWorkflowJobAccepted> {
  return post(token, projectPath(projectId, "/retry"), "重新生成失败");
}

export function rewriteArticleWorkflowProject(
  token: string,
  projectId: string,
  body: {
    readonly instruction: string;
    readonly generationMode?: ArticleWorkflowGenerationMode;
    readonly regenerateImages?: boolean;
  },
): Promise<ArticleWorkflowJobAccepted> {
  return post(token, projectPath(projectId, "/rewrite"), "AI 改稿失败", body);
}

export function generateArticleWorkflowImages(
  token: string,
  projectId: string,
): Promise<{ readonly projectId: string; readonly queued: boolean }> {
  return post(token, projectPath(projectId, "/images/generate"), "生成配图失败");
}

export function regenerateArticleWorkflowImage(
  token: string,
  projectId: string,
  slot: string,
  body: { readonly promptOverride?: string },
): Promise<ArticleWorkflowProject> {
  const path = projectPath(projectId, `/images/${encodeURIComponent(slot)}/regenerate`);

  return post(token, path, "重生图片失败", body);
}

/** 确定性主题换肤：后端按 bodyMarkdown + 新主题重渲正文，返回更新后的项目。 */
export function applyArticleWorkflowTheme(
  token: string,
  projectId: string,
  body: Pick<ArticleWorkflowProjectSummary, "theme" | "themeColor" | "galleryMode">,
): Promise<ArticleWorkflowProject> {
  return patch(token, projectPath(projectId, "/theme"), "应用主题失败", body);
}
