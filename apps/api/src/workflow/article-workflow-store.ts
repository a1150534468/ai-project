import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
} from "@ai-assistant/article-workflow";
import { jsonValue } from "./article-workflow-serializer.js";

export async function findOwnedArticleWorkflowProject(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
) {
  return prisma.articleWorkflowProject.findFirst({ where: { id: projectId, userId } });
}

export type ArticleWorkflowProjectStatePatch = Partial<{
  title: string;
  summary: string;
  generationMode: ArticleWorkflowGenerationMode;
  bodyHtml: string;
  bodyMarkdown: string;
  captionText: string;
  tags: readonly string[];
  imageManifestJson: readonly ArticleWorkflowImageAsset[];
  status: ArticleWorkflowProjectStatus;
  progressStage: string;
  progressPercent: number;
  progressMessage: string | null;
  error: string | null;
  billingOperationId: string | null;
}>;

/**
 * patch → Prisma data 的唯一转换点。
 * undefined 一律保持 undefined（Prisma 语义 = 不动该列），不要在这里补默认值。
 */
function articleWorkflowStateData(data: ArticleWorkflowProjectStatePatch) {
  return {
    title: data.title,
    summary: data.summary,
    generationMode: data.generationMode,
    bodyHtml: data.bodyHtml,
    bodyMarkdown: data.bodyMarkdown,
    captionText: data.captionText,
    tagsJson: data.tags ? jsonValue(data.tags) : undefined,
    imageManifestJson: data.imageManifestJson ? jsonValue(data.imageManifestJson) : undefined,
    status: data.status,
    progressStage: data.progressStage,
    progressPercent: data.progressPercent,
    progressMessage: data.progressMessage,
    error: data.error,
    billingOperationId: data.billingOperationId,
  };
}

/**
 * 终态写入的受保护变体：只在项目仍处于 generating|revising 时生效。
 * 返回 false 表示 reaper 已抢先把项目置 failed（进程曾卡死超过阈值），
 * 此时调用方必须跳过结算——reserve 已被 reaper 退款，再 settle 就是双结算。
 */
export async function finalizeArticleWorkflowProjectState(
  prisma: PrismaClient,
  projectId: string,
  data: ArticleWorkflowProjectStatePatch,
): Promise<boolean> {
  const result = await prisma.articleWorkflowProject.updateMany({
    where: { id: projectId, status: { in: ["generating", "revising"] } },
    data: articleWorkflowStateData(data),
  });
  return result.count === 1;
}

export async function updateArticleWorkflowProjectState(
  prisma: PrismaClient,
  projectId: string,
  data: ArticleWorkflowProjectStatePatch,
) {
  return prisma.articleWorkflowProject.update({
    where: { id: projectId },
    data: articleWorkflowStateData(data),
  });
}
