import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowGalleryMode,
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
} from "@ai-assistant/article-workflow";
import { jsonValue } from "./article-workflow-serializer.js";
import type { ArticleProjectRow } from "./article-workflow-shared.js";

type ArticleWorkflowDb = Pick<PrismaClient, "articleWorkflowProject">;

export type ArticleWorkflowProjectStatePatch = Partial<{
  title: string;
  summary: string;
  generationMode: ArticleWorkflowGenerationMode;
  bodyHtml: string;
  bodyMarkdown: string;
  captionText: string;
  tags: readonly string[];
  imageManifestJson: readonly ArticleWorkflowImageAsset[];
  theme: string;
  themeColor: string | null;
  galleryMode: ArticleWorkflowGalleryMode;
  status: ArticleWorkflowProjectStatus;
  progressStage: string;
  progressPercent: number;
  progressMessage: string | null;
  error: string | null;
}>;

export interface ArticleWorkflowStateGuard {
  readonly userId?: string;
  readonly statuses?: readonly string[];
  readonly updatedAt?: Date;
}

export class ArticleWorkflowLeaseLostError extends Error {
  constructor(projectId: string) {
    super(`图文任务已失去写入租约: ${projectId}`);
    this.name = "ArticleWorkflowLeaseLostError";
  }
}

export async function findOwnedArticleWorkflowProject(
  db: ArticleWorkflowDb,
  userId: string,
  projectId: string,
): Promise<ArticleProjectRow | null> {
  return db.articleWorkflowProject.findFirst({ where: { id: projectId, userId } });
}

function projectStateData(patch: ArticleWorkflowProjectStatePatch, updatedAt?: Date) {
  return {
    title: patch.title,
    summary: patch.summary,
    generationMode: patch.generationMode,
    bodyHtml: patch.bodyHtml,
    bodyMarkdown: patch.bodyMarkdown,
    captionText: patch.captionText,
    tagsJson: patch.tags === undefined ? undefined : jsonValue(patch.tags),
    imageManifestJson:
      patch.imageManifestJson === undefined ? undefined : jsonValue(patch.imageManifestJson),
    theme: patch.theme,
    themeColor: patch.themeColor,
    galleryMode: patch.galleryMode,
    status: patch.status,
    progressStage: patch.progressStage,
    progressPercent: patch.progressPercent,
    progressMessage: patch.progressMessage,
    error: patch.error,
    updatedAt,
  };
}

function nextVersion(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

/**
 * 条件更新项目并返回数据库实际写入的行。传入 updatedAt 时，它既是 CAS 条件，也是
 * 单调递增的运行版本；即使同一毫秒内连续写进度，旧 worker 也无法命中 ABA 后的新任务。
 */
export async function updateArticleWorkflowProjectState(
  db: ArticleWorkflowDb,
  projectId: string,
  patch: ArticleWorkflowProjectStatePatch,
  guard: ArticleWorkflowStateGuard = {},
): Promise<ArticleProjectRow | null> {
  const status = guard.statuses
    ? guard.statuses.length === 1
      ? guard.statuses[0]
      : { in: [...guard.statuses] }
    : undefined;
  const where = {
    id: projectId,
    ...(guard.userId ? { userId: guard.userId } : {}),
    ...(status ? { status } : {}),
    ...(guard.updatedAt ? { updatedAt: guard.updatedAt } : {}),
  };
  const rows = await db.articleWorkflowProject.updateManyAndReturn({
    where,
    data: projectStateData(patch, guard.updatedAt ? nextVersion(guard.updatedAt) : undefined),
  });
  return rows[0] ?? null;
}

export async function writeArticleWorkflowRunState(
  db: ArticleWorkflowDb,
  projectId: string,
  expectedVersion: Date,
  patch: ArticleWorkflowProjectStatePatch,
): Promise<Date> {
  const updated = await updateArticleWorkflowProjectState(db, projectId, patch, {
    statuses: ["generating", "revising"],
    updatedAt: expectedVersion,
  });
  if (!updated) throw new ArticleWorkflowLeaseLostError(projectId);
  return updated.updatedAt;
}

export async function finalizeArticleWorkflowProjectState(
  db: ArticleWorkflowDb,
  projectId: string,
  expectedVersion: Date,
  patch: ArticleWorkflowProjectStatePatch,
): Promise<boolean> {
  return Boolean(
    await updateArticleWorkflowProjectState(db, projectId, patch, {
      statuses: ["generating", "revising"],
      updatedAt: expectedVersion,
    }),
  );
}
