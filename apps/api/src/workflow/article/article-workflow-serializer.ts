import { Prisma } from "@prisma/client";
import {
  articleWorkflowPlatformConfig,
  articleWorkflowTheme,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowCreationMode,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowProjectStatus,
  type ArticleWorkflowSourceFormat,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import {
  articleWorkflowCreationConfigSchema,
  articleWorkflowImageManifestItemSchema,
  articleWorkflowTagsSchema,
} from "./article-workflow-schema.js";
import { articleWorkflowResponseBodyHtml, articleWorkflowResponseImageUrl } from "./article-workflow-image-url.js";
import type { ArticleProjectRow, ArticleWorkflowPersistedProject } from "./article-workflow-shared.js";

const titleOrFallback = (title: string) => title.trim() || "未命名图文";

export function parseArticleWorkflowTagsJson(value: unknown): readonly string[] {
  const result = articleWorkflowTagsSchema.safeParse(value);
  return result.success ? result.data : [];
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function parseArticleWorkflowImageManifestJson(value: unknown): readonly ArticleWorkflowImageAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const result = articleWorkflowImageManifestItemSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

export function parseArticleWorkflowCreationConfigJson(mode: unknown, value: unknown): ArticleWorkflowCreationConfig {
  const expected: ArticleWorkflowCreationMode = mode === "topic" ? "topic" : "source";
  const result = articleWorkflowCreationConfigSchema.safeParse(value);
  return result.success && result.data.mode === expected
    ? result.data
    : { mode: "source", generateImages: true };
}

export function readArticleWorkflowProject(row: ArticleProjectRow): ArticleWorkflowPersistedProject {
  const creationConfig = parseArticleWorkflowCreationConfigJson(row.creationMode, row.creationConfigJson);
  const platform = articleWorkflowPlatformConfig(row.platform);
  const theme = articleWorkflowTheme(row.theme) as ArticleWorkflowThemeKey;
  const galleryMode = (row.galleryMode === "grid" || row.galleryMode === "stack"
    ? row.galleryMode
    : "collage") as ArticleWorkflowGalleryMode;
  return {
    id: row.id,
    userId: row.userId,
    creationMode: creationConfig.mode,
    creationConfig,
    sourceFormat: row.sourceFormat as ArticleWorkflowSourceFormat,
    sourceText: row.sourceText,
    generationMode: row.generationMode as ArticleWorkflowGenerationMode,
    platform: platform.platform,
    batchId: row.batchId,
    theme,
    themeColor: row.themeColor ?? null,
    galleryMode,
    title: titleOrFallback(row.title),
    summary: row.summary.trim(),
    bodyHtml: row.bodyHtml.trim(),
    bodyMarkdown: row.bodyMarkdown?.trim() ?? "",
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

function summary(row: ArticleProjectRow, project: ArticleWorkflowPersistedProject) {
  return {
    id: project.id,
    title: project.title,
    summary: project.summary,
    generationMode: project.generationMode,
    creationMode: project.creationMode,
    platform: project.platform,
    batchId: project.batchId,
    theme: project.theme,
    themeColor: project.themeColor,
    galleryMode: project.galleryMode,
    status: project.status as ArticleWorkflowProjectStatus,
    progressStage: project.progressStage,
    progressPercent: project.progressPercent,
    progressMessage: project.progressMessage,
    error: project.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeArticleWorkflowProjectSummary(row: ArticleProjectRow) {
  return summary(row, readArticleWorkflowProject(row));
}

export function serializeArticleWorkflowProject(row: ArticleProjectRow, env: NodeJS.ProcessEnv = process.env) {
  const project = readArticleWorkflowProject(row);
  return {
    ...summary(row, project),
    sourceFormat: project.sourceFormat,
    sourceText: project.sourceText,
    creationConfig: project.creationConfig,
    bodyHtml: articleWorkflowResponseBodyHtml({ html: project.bodyHtml, env }),
    bodyMarkdown: project.bodyMarkdown,
    captionText: project.captionText,
    tags: project.tags,
    imageManifestJson: project.imageManifest.map((image) => ({
      ...image,
      imageUrl: articleWorkflowResponseImageUrl({ url: image.imageUrl, env }),
      thumbnailUrl: articleWorkflowResponseImageUrl({ url: image.thumbnailUrl, env }),
    })),
  };
}
