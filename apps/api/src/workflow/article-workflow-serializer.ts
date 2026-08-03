import { Prisma } from "@prisma/client";
import {
  articleWorkflowPlatformConfig,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowCreationMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowProjectStatus,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import {
  articleWorkflowImageManifestItemSchema,
  articleWorkflowCreationConfigSchema,
  articleWorkflowTagsSchema,
} from "./article-workflow-schema.js";
import {
  articleWorkflowResponseBodyHtml,
  articleWorkflowResponseImageUrl,
} from "./article-workflow-image-url.js";
import type { ArticleProjectRow, ArticleWorkflowPersistedProject } from "./article-workflow-shared.js";

function fallbackTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed || "未命名图文";
}

export function parseArticleWorkflowTagsJson(value: unknown): readonly string[] {
  const parsed = articleWorkflowTagsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function parseArticleWorkflowImageManifestJson(value: unknown): readonly ArticleWorkflowImageAsset[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => articleWorkflowImageManifestItemSchema.safeParse(item))
    .filter((item): item is { success: true; data: ArticleWorkflowImageAsset } => item.success)
    .map((item) => item.data);
}

export function parseArticleWorkflowCreationConfigJson(
  mode: unknown,
  value: unknown,
): ArticleWorkflowCreationConfig {
  const creationMode: ArticleWorkflowCreationMode = mode === "topic" ? "topic" : "source";
  const parsed = articleWorkflowCreationConfigSchema.safeParse(value);
  if (parsed.success && parsed.data.mode === creationMode) return parsed.data;
  return { mode: "source", generateImages: true };
}

export function readArticleWorkflowProject(row: ArticleProjectRow): ArticleWorkflowPersistedProject {
  const creationConfig = parseArticleWorkflowCreationConfigJson(row.creationMode, row.creationConfigJson);
  return {
    id: row.id,
    userId: row.userId,
    creationMode: creationConfig.mode,
    creationConfig,
    sourceFormat: row.sourceFormat as ArticleWorkflowSourceFormat,
    sourceText: row.sourceText,
    generationMode: row.generationMode as ArticleWorkflowGenerationMode,
    platform: articleWorkflowPlatformConfig(row.platform).platform,
    batchId: row.batchId,
    title: fallbackTitle(row.title),
    summary: row.summary.trim(),
    bodyHtml: row.bodyHtml.trim(),
    captionText: row.captionText.trim(),
    tags: parseArticleWorkflowTagsJson(row.tagsJson),
    imageManifest: parseArticleWorkflowImageManifestJson(row.imageManifestJson),
    status: row.status,
    progressStage: row.progressStage,
    progressPercent: row.progressPercent,
    progressMessage: row.progressMessage,
    error: row.error,
  };
}

export function serializeArticleWorkflowProjectSummary(row: ArticleProjectRow) {
  const project = readArticleWorkflowProject(row);
  return {
    id: project.id,
    title: project.title,
    summary: project.summary,
    generationMode: project.generationMode,
    creationMode: project.creationMode,
    platform: project.platform,
    batchId: project.batchId,
    status: project.status as ArticleWorkflowProjectStatus,
    progressStage: project.progressStage,
    progressPercent: project.progressPercent,
    progressMessage: project.progressMessage,
    error: project.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 出参：库里存的是稳定代理地址，这里现签一份短期地址给页面用。
 *
 * 为什么放在序列化层：正文里的 `<img>` 是浏览器直接发的请求，带不上 `Authorization`
 * 头，而 web 端的登录态只在 localStorage 里。签名地址是让页面显示出图的唯一办法，
 * 又不能落库（会过期）——所以只能每次读的时候现加。
 *
 * `env` 缺省取 `process.env`：签名密钥就是 `SESSION_SECRET`。
 */
export function serializeArticleWorkflowProject(row: ArticleProjectRow, env: NodeJS.ProcessEnv = process.env) {
  const project = readArticleWorkflowProject(row);
  return {
    ...serializeArticleWorkflowProjectSummary(row),
    sourceFormat: project.sourceFormat,
    sourceText: project.sourceText,
    creationConfig: project.creationConfig,
    bodyHtml: articleWorkflowResponseBodyHtml({ html: project.bodyHtml, env }),
    captionText: project.captionText,
    tags: project.tags,
    imageManifestJson: project.imageManifest.map((image) => ({
      ...image,
      imageUrl: articleWorkflowResponseImageUrl({ url: image.imageUrl, env }),
      thumbnailUrl: articleWorkflowResponseImageUrl({ url: image.thumbnailUrl, env }),
    })),
  };
}
