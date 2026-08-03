import type {
  ArticleWorkflowCreationConfig,
  ArticleWorkflowImageAsset,
  ArticleWorkflowPlatform,
  ArticleWorkflowPlatformConfig,
  ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { assertArticleWorkflowImitationOriginality } from "./article-workflow-creation.js";
import type { PrismaClient } from "@prisma/client";
import {
  articleWorkflowCaptionSummary,
  normalizeArticleWorkflowCaptionPlan,
} from "./article-workflow-caption.js";
import {
  createPlannedArticleImage,
  mergeArticleImageManifest,
} from "./article-workflow-image-manifest.js";
import { generateArticleWorkflowCaptionPlan } from "./article-workflow-llm.js";
import type { ArticleWorkflowCaptionPlan } from "./article-workflow-schema.js";
import type { LlmClientLike } from "./article-workflow-shared.js";
import { updateArticleWorkflowProjectState } from "./article-workflow-store.js";
import type { MaterializedArticle, PopulateArticleImages } from "./article-workflow-runner.js";

function plannedCaptionImageManifest(
  images: ArticleWorkflowCaptionPlan["images"],
): readonly ArticleWorkflowImageAsset[] {
  return images.map((image) => createPlannedArticleImage({
    slot: image.slot,
    prompt: image.prompt,
    alt: image.alt,
    caption: image.caption,
  }));
}

/**
 * 小红书 / 抖音链路：一次 LLM 出「标题 + 文案 + 标签 + 配图计划」，然后只生图。
 *
 * 与公众号链路的差异都在这里：不排版、不过 HTML guard、bodyHtml 恒为空串。
 * 配图仍走注入的 populateImages，图片费回滚清单由调用方统一持有。
 */
export async function materializeCaptionArticle(args: {
  readonly creationConfig: ArticleWorkflowCreationConfig;
  readonly prisma: PrismaClient;
  readonly llm: LlmClientLike;
  readonly model: string;
  readonly projectId: string;
  readonly platform: ArticleWorkflowPlatform;
  readonly platformConfig: ArticleWorkflowPlatformConfig;
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly sourceText: string;
  readonly currentCaption?: string;
  readonly currentImages?: readonly ArticleWorkflowImageAsset[];
  readonly instruction?: string;
  readonly regenerateImages: boolean;
  readonly generateImages: boolean;
  readonly populateImages: PopulateArticleImages;
}): Promise<MaterializedArticle> {
  const rawPlan = await generateArticleWorkflowCaptionPlan({
    creationConfig: args.creationConfig,
    llm: args.llm,
    model: args.model,
    platform: args.platform,
    config: args.platformConfig,
    sourceFormat: args.sourceFormat,
    sourceText: args.sourceText,
    currentCaption: args.currentCaption,
    instruction: args.instruction,
  });
  const plan = normalizeArticleWorkflowCaptionPlan({ plan: rawPlan, config: args.platformConfig });
  assertArticleWorkflowImitationOriginality({
    creationConfig: args.creationConfig,
    outputText: [plan.title, plan.captionText, ...plan.tags].join("\n"),
  });
  const summary = articleWorkflowCaptionSummary(plan.captionText);

  let imageManifest = plannedCaptionImageManifest(plan.images);
  if (args.currentImages && args.currentImages.length > 0 && !args.regenerateImages) {
    imageManifest = mergeArticleImageManifest(imageManifest, args.currentImages);
  }

  await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
    title: plan.title,
    summary,
    captionText: plan.captionText,
    tags: plan.tags,
    imageManifestJson: imageManifest,
    progressStage: args.generateImages ? "illustrating" : "finalizing",
    progressPercent: args.generateImages ? 35 : 92,
    progressMessage: args.generateImages ? "AI 正在生成配图" : "文案即将完成",
  });

  if (args.generateImages) {
    imageManifest = await args.populateImages({
      imageManifest,
      onProgress: async (completed, total) => {
        await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
          title: plan.title,
          summary,
          captionText: plan.captionText,
          tags: plan.tags,
          imageManifestJson: imageManifest,
          progressStage: "illustrating",
          progressPercent: 35 + Math.round((completed / Math.max(total, 1)) * 60),
          progressMessage: `正在生成配图（${completed}/${total}）`,
        });
      },
    });
  }

  return {
    title: plan.title,
    summary,
    bodyHtml: "",
    captionText: plan.captionText,
    tags: plan.tags,
    imageManifest,
  };
}
