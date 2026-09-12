import type { PrismaClient } from "@prisma/client";
import type { ArticleWorkflowProjectStatus } from "@ai-assistant/article-workflow";
import { findOwnedArticleWorkflowProject, updateArticleWorkflowProjectState } from "./article-workflow-store.js";
import type { ArticleWorkflowProjectStatePatch } from "./article-workflow-store.js";

const ACTIVE_STATUSES = new Set(["draft", "generating", "revising"]);

export class ArticleBatchBusyError extends Error {}

export function isSerializableConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    "code" in error && (error as { code?: string }).code === "P2034");
}

export async function deleteOwnedArticleBatch(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const project = await findOwnedArticleWorkflowProject(tx, userId, projectId);
      if (!project) return null;
      const projects = project.batchId
        ? await tx.articleWorkflowProject.findMany({ where: { userId, batchId: project.batchId } })
        : [project];
      if (projects.some((item) => ACTIVE_STATUSES.has(item.status))) throw new ArticleBatchBusyError();

      const deleted = await tx.articleWorkflowProject.deleteMany({
        where: {
          userId,
          OR: projects.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })),
        },
      });
      if (deleted.count !== projects.length) throw new ArticleBatchBusyError();
      return { deleted: deleted.count, batchId: project.batchId };
    },
    { isolationLevel: "Serializable" },
  );
}

export function claimArticleWorkflowProject(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  version: Date,
  statuses: readonly ArticleWorkflowProjectStatus[],
  patch: ArticleWorkflowProjectStatePatch,
) {
  return updateArticleWorkflowProjectState(prisma, projectId, patch, {
    userId,
    statuses,
    updatedAt: version,
  });
}
