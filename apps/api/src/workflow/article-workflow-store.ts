import type { PrismaClient } from "@prisma/client";
import type {
  ArticleWorkflowGenerationMode,
  ArticleWorkflowImageAsset,
  ArticleWorkflowProjectStatus,
} from "@yc/article-workflow";
import { jsonValue } from "./article-workflow-serializer.js";

export async function findOwnedArticleWorkflowProject(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
) {
  return prisma.articleWorkflowProject.findFirst({ where: { id: projectId, userId } });
}

export async function updateArticleWorkflowProjectState(
  prisma: PrismaClient,
  projectId: string,
  data: Partial<{
    title: string;
    summary: string;
    generationMode: ArticleWorkflowGenerationMode;
    bodyHtml: string;
    imageManifestJson: readonly ArticleWorkflowImageAsset[];
    status: ArticleWorkflowProjectStatus;
    progressStage: string;
    progressPercent: number;
    progressMessage: string | null;
    error: string | null;
  }>,
) {
  return prisma.articleWorkflowProject.update({
    where: { id: projectId },
    data: {
      title: data.title,
      summary: data.summary,
      generationMode: data.generationMode,
      bodyHtml: data.bodyHtml,
      imageManifestJson: data.imageManifestJson ? jsonValue(data.imageManifestJson) : undefined,
      status: data.status,
      progressStage: data.progressStage,
      progressPercent: data.progressPercent,
      progressMessage: data.progressMessage,
      error: data.error,
    },
  });
}
