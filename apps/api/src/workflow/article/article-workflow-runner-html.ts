import {
  articleWorkflowMarkdownFromVisibleText,
  articleWorkflowPreservedBodyMarkdown,
  articleWorkflowVisibleTextFromMarkdown,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatformConfig,
  type ArticleWorkflowSourceFormat,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import type { PrismaClient } from "@prisma/client";
import { assertArticleWorkflowImitationOriginality } from "./article-workflow-creation.js";
import { assertArticleWorkflowHtmlFragment, repairArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import { renderDeterministicArticleBodyHtmlGuarded } from "./article-workflow-deterministic.js";
import { applyArticleImageManifestToHtml, createPlannedArticleImage, mergeArticleImageManifest } from "./article-workflow-image-manifest.js";
import { generateArticleWorkflowPlan, renderArticleWorkflowBodyHtml } from "./article-workflow-llm.js";
import { normalizeArticleWorkflowPlan } from "./article-workflow-plan.js";
import type { MaterializedArticle, PopulateArticleImages, UpdateArticleProgress } from "./article-workflow-runner.js";
import type { ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";

type HtmlRunnerDeps = Required<Pick<ArticleWorkflowRouteDeps, "llm" | "fetchFn" | "env">> & {
  readonly prisma: PrismaClient;
};

function preservedBody(args: {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentHtml?: string;
  readonly title: string;
}): string {
  const currentText = args.currentHtml ? articleWorkflowVisibleTextFromHtml(args.currentHtml) : "";
  return currentText
    ? articleWorkflowMarkdownFromVisibleText(currentText)
    : articleWorkflowPreservedBodyMarkdown({ format: args.sourceFormat, sourceText: args.sourceText, title: args.title });
}

function plannedImages(images: readonly {
  readonly slot: ArticleWorkflowImageAsset["slot"];
  readonly alt: string;
  readonly caption: string;
  readonly prompt: string;
}[]): readonly ArticleWorkflowImageAsset[] {
  return images.map((image) => createPlannedArticleImage(image));
}

export async function materializeHtmlFragmentArticle(
  args: HtmlRunnerDeps & {
    readonly creationConfig: ArticleWorkflowCreationConfig;
    readonly userId: string;
    readonly projectId: string;
    readonly sourceFormat: ArticleWorkflowSourceFormat;
    readonly sourceText: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly currentHtml?: string;
    readonly currentImages?: readonly ArticleWorkflowImageAsset[];
    readonly instruction?: string;
    readonly regenerateImages: boolean;
    readonly generateImages: boolean;
    readonly model: string;
    readonly theme: ArticleWorkflowThemeKey;
    readonly themeColor: string | null;
    readonly galleryMode: ArticleWorkflowGalleryMode;
    readonly platformConfig: ArticleWorkflowPlatformConfig;
    readonly populateImages: PopulateArticleImages;
    readonly updateProgress: UpdateArticleProgress;
  },
): Promise<MaterializedArticle> {
  const rawPlan = await generateArticleWorkflowPlan({
    creationConfig: args.creationConfig,
    llm: args.llm,
    model: args.model,
    sourceFormat: args.sourceFormat,
    sourceText: args.sourceText,
    generationMode: args.generationMode,
    currentHtml: args.currentHtml,
    instruction: args.instruction,
  });
  const plan = normalizeArticleWorkflowPlan({ plan: rawPlan, config: args.platformConfig });
  const bodyMarkdown = args.generationMode === "preserve-text"
    ? preservedBody({ sourceFormat: args.sourceFormat, sourceText: args.sourceText, currentHtml: args.currentHtml, title: rawPlan.title })
    : plan.bodyMarkdown;
  const visibleText = articleWorkflowVisibleTextFromMarkdown(bodyMarkdown);
  assertArticleWorkflowImitationOriginality({
    creationConfig: args.creationConfig,
    outputText: [plan.title, plan.summary, visibleText].join("\n"),
  });
  if (args.generationMode === "preserve-text") {
    const expected = articleWorkflowVisibleTextFromMarkdown(preservedBody({
      sourceFormat: args.sourceFormat,
      sourceText: args.sourceText,
      currentHtml: args.currentHtml,
      title: rawPlan.title,
    }));
    if (visibleText !== expected) throw new Error("原始正文在保留模式下无法稳定还原");
  }

  let imageManifest = plannedImages(plan.images);
  if (args.currentImages?.length && !args.regenerateImages) {
    imageManifest = mergeArticleImageManifest(imageManifest, args.currentImages);
  }
  const saveProgress = (completed: number, total: number) => args.updateProgress({
    title: plan.title,
    summary: plan.summary,
    generationMode: args.generationMode,
    imageManifestJson: imageManifest,
    progressStage: "illustrating",
    progressPercent: 35 + Math.round((completed / Math.max(total, 1)) * 35),
    progressMessage: `正在生成配图（${completed}/${total}）`,
  });
  await args.updateProgress({
    title: plan.title,
    summary: plan.summary,
    generationMode: args.generationMode,
    imageManifestJson: imageManifest,
    progressStage: args.generateImages ? "illustrating" : "layout",
    progressPercent: args.generateImages ? 35 : 72,
    progressMessage: args.generateImages ? "AI 正在生成配图" : "AI 正在排版正文",
  });
  if (args.generateImages) {
    imageManifest = await args.populateImages({ imageManifest, onProgress: saveProgress });
  }
  await args.updateProgress({
    progressStage: "layout",
    progressPercent: 80,
    progressMessage: "AI 正在排版正文",
    imageManifestJson: imageManifest,
  });

  const deterministic = renderDeterministicArticleBodyHtmlGuarded({
    theme: args.theme,
    themeColor: args.themeColor,
    bodyMarkdown,
    imageManifest,
    galleryMode: args.galleryMode,
  });
  const bodyHtml = deterministic ?? applyArticleImageManifestToHtml(
    assertArticleWorkflowHtmlFragment({
      html: repairArticleWorkflowHtmlFragment(await renderArticleWorkflowBodyHtml({
        llm: args.llm,
        model: args.model,
        bodyMarkdown,
        imageManifest,
      })),
      expectedVisibleText: visibleText,
      requiredImageSlots: imageManifest.map((image) => image.slot),
    }),
    imageManifest,
  );
  return {
    title: plan.title,
    summary: plan.summary,
    bodyHtml,
    bodyMarkdown: deterministic === null ? "" : bodyMarkdown,
    captionText: "",
    tags: [],
    imageManifest,
  };
}
