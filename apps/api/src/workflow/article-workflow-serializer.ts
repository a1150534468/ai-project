import { Prisma } from "@prisma/client";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { articleWorkflowImageManifestItemSchema } from "./article-workflow-schema.js";
import type { ArticleProjectRow, ArticleWorkflowPersistedProject } from "./article-workflow-shared.js";

function fallbackTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed || "未命名图文";
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

export function readArticleWorkflowProject(row: ArticleProjectRow): ArticleWorkflowPersistedProject {
  return {
    id: row.id,
    userId: row.userId,
    sourceFormat: row.sourceFormat as ArticleWorkflowSourceFormat,
    sourceText: row.sourceText,
    generationMode: row.generationMode as ArticleWorkflowGenerationMode,
    title: fallbackTitle(row.title),
    summary: row.summary.trim(),
    bodyHtml: row.bodyHtml.trim(),
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
    status: project.status as ArticleWorkflowProjectStatus,
    progressStage: project.progressStage,
    progressPercent: project.progressPercent,
    progressMessage: project.progressMessage,
    error: project.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeArticleWorkflowProject(row: ArticleProjectRow) {
  const project = readArticleWorkflowProject(row);
  return {
    ...serializeArticleWorkflowProjectSummary(row),
    sourceFormat: project.sourceFormat,
    sourceText: project.sourceText,
    bodyHtml: project.bodyHtml,
    imageManifestJson: project.imageManifest,
  };
}
