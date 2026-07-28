import {
  articleWorkflowMarkdownFromVisibleText,
  articleWorkflowPreservedBodyMarkdown,
  articleWorkflowVisibleTextFromMarkdown,
  articleWorkflowVisibleTextFromSource,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import type { PrismaClient } from "@prisma/client";
import { runReservedArticleTextTask } from "./article-workflow-billing.js";
import { assertArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import {
  applyArticleImageManifestToHtml,
  createPlannedArticleImage,
  mergeArticleImageManifest,
} from "./article-workflow-image-manifest.js";
import { populateArticleWorkflowImages } from "./article-workflow-images.js";
import {
  estimateArticleWorkflowReserveUnits,
  generateArticleWorkflowPlan,
  renderArticleWorkflowBodyHtml,
} from "./article-workflow-llm.js";
import { readArticleWorkflowProject } from "./article-workflow-serializer.js";
import type { ArticleProjectRow, ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";
import { safeErrorMessage } from "./ecom-route-helpers.js";
import { updateArticleWorkflowProjectState } from "./article-workflow-store.js";

type RunnerDeps = Required<Pick<ArticleWorkflowRouteDeps, "billing" | "llm" | "fetchFn" | "env">> & {
  readonly prisma: PrismaClient;
};

function expectedPreservedVisibleText(args: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentHtml?: string;
  readonly title: string;
}): string {
  const preservedMarkdown = preservedBodyMarkdown({
    sourceFormat: args.sourceFormat,
    sourceText: args.sourceText,
    currentHtml: args.currentHtml,
    title: args.title,
  });
  return articleWorkflowVisibleTextFromMarkdown(preservedMarkdown);
}

function plannedImageManifest(images: readonly {
  slot: ArticleWorkflowImageAsset["slot"];
  role: ArticleWorkflowImageAsset["role"];
  alt: string;
  caption: string;
  prompt: string;
}[]): readonly ArticleWorkflowImageAsset[] {
  return images.map((image) => createPlannedArticleImage({
    slot: image.slot,
    prompt: image.prompt,
    alt: image.alt,
    caption: image.caption,
  }));
}

function preservedBodyMarkdown(args: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentHtml?: string;
  readonly title: string;
}): string {
  const currentVisibleText = args.currentHtml ? articleWorkflowVisibleTextFromHtml(args.currentHtml) : "";
  if (currentVisibleText) return articleWorkflowMarkdownFromVisibleText(currentVisibleText);
  return articleWorkflowPreservedBodyMarkdown({
    format: args.sourceFormat,
    sourceText: args.sourceText,
    title: args.title,
  });
}

async function materializeArticleWorkflow(args: RunnerDeps & {
  readonly userId: string;
  readonly projectId: string;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly currentHtml?: string;
  readonly currentImages?: readonly ArticleWorkflowImageAsset[];
  readonly instruction?: string;
  readonly regenerateImages: boolean;
  readonly model: string;
}): Promise<{
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}> {
  return runReservedArticleTextTask({
    billing: args.billing,
    userId: args.userId,
    projectId: args.projectId,
    units: estimateArticleWorkflowReserveUnits({
      sourceText: args.sourceText,
      currentHtml: args.currentHtml,
      instruction: args.instruction,
    }),
    // 落库供 reaper 在进程崩溃后退款；终态写入时清空
    onReserved: async (operationId) => {
      await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
        billingOperationId: operationId,
      });
    },
    work: async () => {
      const plan = await generateArticleWorkflowPlan({
        llm: args.llm,
        model: args.model,
        sourceFormat: args.sourceFormat,
        sourceText: args.sourceText,
        generationMode: args.generationMode,
        currentHtml: args.currentHtml,
        instruction: args.instruction,
      });
      const bodyMarkdown = args.generationMode === "preserve-text"
        ? preservedBodyMarkdown({
          sourceFormat: args.sourceFormat,
          sourceText: args.sourceText,
          currentHtml: args.currentHtml,
          title: plan.title,
        })
        : plan.bodyMarkdown;
      const bodyVisibleText = articleWorkflowVisibleTextFromMarkdown(bodyMarkdown);
      const expectedVisibleText = args.generationMode === "preserve-text"
        ? expectedPreservedVisibleText({
          sourceFormat: args.sourceFormat,
          sourceText: args.sourceText,
          currentHtml: args.currentHtml,
          title: plan.title,
        })
        : "";
      if (args.generationMode === "preserve-text" && bodyVisibleText !== expectedVisibleText) {
        throw new Error("原始正文在保留模式下无法稳定还原");
      }

      let imageManifest = plannedImageManifest(plan.images);
      if (args.currentImages && args.currentImages.length > 0 && !args.regenerateImages) {
        imageManifest = mergeArticleImageManifest(imageManifest, args.currentImages);
      }

      await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
        title: plan.title,
        summary: plan.summary,
        generationMode: args.generationMode,
        imageManifestJson: imageManifest,
        progressStage: "illustrating",
        progressPercent: 35,
        progressMessage: "AI 正在生成配图",
      });

      imageManifest = await populateArticleWorkflowImages({
        prisma: args.prisma,
        billing: args.billing,
        fetchFn: args.fetchFn,
        env: args.env,
        userId: args.userId,
        projectId: args.projectId,
        imageManifest,
        force: args.regenerateImages,
        onProgress: async (completed, total) => {
          await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
            title: plan.title,
            summary: plan.summary,
            generationMode: args.generationMode,
            imageManifestJson: imageManifest,
            progressStage: "illustrating",
            progressPercent: 35 + Math.round((completed / Math.max(total, 1)) * 35),
            progressMessage: `正在生成配图（${completed}/${total}）`,
          });
        },
      });

      await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
        progressStage: "layout",
        progressPercent: 80,
        progressMessage: "AI 正在排版正文",
        imageManifestJson: imageManifest,
      });

      const rawHtml = await renderArticleWorkflowBodyHtml({
        llm: args.llm,
        model: args.model,
        bodyMarkdown,
        imageManifest,
      });
      const guardedHtml = assertArticleWorkflowHtmlFragment({
        html: rawHtml,
        expectedVisibleText: bodyVisibleText,
        requiredImageSlots: imageManifest.map((item) => item.slot),
      });
      const bodyHtml = applyArticleImageManifestToHtml(guardedHtml, imageManifest);

      return {
        title: plan.title,
        summary: plan.summary,
        bodyHtml,
        imageManifest,
      };
    },
  });
}

export async function runInitialArticleWorkflowGeneration(args: RunnerDeps & {
  readonly userId: string;
  readonly projectId: string;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly model: string;
}): Promise<void> {
  try {
    await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
      status: "generating",
      progressStage: "drafting",
      progressPercent: 12,
      progressMessage: "AI 正在整理文章",
      error: null,
    });
    const result = await materializeArticleWorkflow({
      ...args,
      currentHtml: "",
      currentImages: [],
      instruction: "",
      regenerateImages: true,
    });
    await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "已生成完成",
      error: null,
      billingOperationId: null,
      title: result.title,
      summary: result.summary,
      generationMode: args.generationMode,
      bodyHtml: result.bodyHtml,
      imageManifestJson: result.imageManifest,
    });
  } catch (error) {
    await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
      status: "failed",
      progressStage: "failed",
      progressPercent: 100,
      progressMessage: "生成失败",
      error: safeErrorMessage(error),
      billingOperationId: null,
    }).catch(() => undefined);
  }
}

export async function runArticleWorkflowRewrite(args: RunnerDeps & {
  readonly project: ArticleProjectRow;
  readonly instruction: string;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly regenerateImages: boolean;
  readonly model: string;
}): Promise<void> {
  const current = readArticleWorkflowProject(args.project);
  try {
    await updateArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "revising",
      progressStage: "drafting",
      progressPercent: 15,
      progressMessage: "AI 正在改稿",
      error: null,
    });
    const result = await materializeArticleWorkflow({
      ...args,
      userId: args.project.userId,
      projectId: args.project.id,
      sourceFormat: current.sourceFormat,
      sourceText: current.sourceText,
      currentHtml: current.bodyHtml,
      currentImages: current.imageManifest,
    });
    await updateArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "改稿完成",
      error: null,
      billingOperationId: null,
      title: result.title,
      summary: result.summary,
      generationMode: args.generationMode,
      bodyHtml: result.bodyHtml,
      imageManifestJson: result.imageManifest,
    });
  } catch (error) {
    await updateArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "failed",
      progressStage: "failed",
      progressPercent: 100,
      progressMessage: "改稿失败",
      error: safeErrorMessage(error),
      billingOperationId: null,
    }).catch(() => undefined);
  }
}
