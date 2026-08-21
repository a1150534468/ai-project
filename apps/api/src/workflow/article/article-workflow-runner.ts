import {
  articleWorkflowMarkdownFromVisibleText,
  articleWorkflowPlatformConfig,
  articleWorkflowPreservedBodyMarkdown,
  articleWorkflowVisibleTextFromMarkdown,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowPlatformConfig,
  type ArticleWorkflowSourceFormat,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import { assertArticleWorkflowImitationOriginality } from "./article-workflow-creation.js";
import type { PrismaClient } from "@prisma/client";
import { runReservedArticleTextTask } from "./article-workflow-billing.js";
import { assertArticleWorkflowHtmlFragment, repairArticleWorkflowHtmlFragment } from "./article-workflow-html-guard.js";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import { renderDeterministicArticleBodyHtmlGuarded } from "./article-workflow-deterministic.js";
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
import { normalizeArticleWorkflowPlan } from "./article-workflow-plan.js";
import { materializeCaptionArticle } from "./article-workflow-runner-caption.js";
import { readArticleWorkflowProject } from "./article-workflow-serializer.js";
import type { ArticleProjectRow, ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";
import { safeErrorMessage } from "../_shared/ecom-route-helpers.js";
import { finalizeArticleWorkflowProjectState, updateArticleWorkflowProjectState } from "./article-workflow-store.js";

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

function plannedImageManifest(
  images: readonly {
    slot: ArticleWorkflowImageAsset["slot"];
    role: ArticleWorkflowImageAsset["role"];
    alt: string;
    caption: string;
    prompt: string;
  }[],
): readonly ArticleWorkflowImageAsset[] {
  return images.map((image) =>
    createPlannedArticleImage({
      slot: image.slot,
      prompt: image.prompt,
      alt: image.alt,
      caption: image.caption,
    }),
  );
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

export interface MaterializedArticle {
  readonly title: string;
  readonly summary: string;
  readonly bodyHtml: string;
  /** 公众号正文 Markdown：确定性主题换肤的本地渲染输入；auto 主题为空串 */
  readonly bodyMarkdown: string;
  /** caption 平台的正文文案；公众号为空串 */
  readonly captionText: string;
  /** caption 平台的话题标签；公众号为空数组 */
  readonly tags: readonly string[];
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
}

/**
 * 两条产物链路共用的配图填充器。
 *
 * 由 materializeArticleWorkflow 注入，内部已绑好 onCharged 收集器与平台配置——
 * 图片费回滚清单必须只有一份，caption 链路不允许自己再调一次 populateArticleWorkflowImages。
 */
export type PopulateArticleImages = (args: {
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly onProgress: (completed: number, total: number) => Promise<void>;
}) => Promise<readonly ArticleWorkflowImageAsset[]>;

async function commitReadyArticleProject(
  prisma: PrismaClient,
  projectId: string,
  args: {
    readonly progressMessage: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly result: MaterializedArticle;
  },
): Promise<boolean> {
  const committed = await finalizeArticleWorkflowProjectState(prisma, projectId, {
    status: "ready",
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: args.progressMessage,
    error: null,
    billingOperationId: null,
    title: args.result.title,
    summary: args.result.summary,
    generationMode: args.generationMode,
    bodyHtml: args.result.bodyHtml,
    bodyMarkdown: args.result.bodyMarkdown,
    captionText: args.result.captionText,
    tags: args.result.tags,
    imageManifestJson: args.result.imageManifest,
  });
  if (!committed) {
    console.warn(`[article-workflow] 终态写入被跳过（reaper 已收割）project=${projectId}`);
  }
  return committed;
}

async function finalizeFailedArticleProject(
  prisma: PrismaClient,
  projectId: string,
  args: { readonly progressMessage: string; readonly error: unknown },
): Promise<void> {
  const committed = await finalizeArticleWorkflowProjectState(prisma, projectId, {
    status: "failed",
    progressStage: "failed",
    progressPercent: 100,
    progressMessage: args.progressMessage,
    error: safeErrorMessage(args.error),
    billingOperationId: null,
  }).catch(() => false);
  if (!committed) {
    console.warn(`[article-workflow] 失败终态写入被跳过（reaper 已收割）project=${projectId}`);
  }
}

async function materializeArticleWorkflow(
  args: RunnerDeps & {
    readonly creationConfig: ArticleWorkflowCreationConfig;
    readonly userId: string;
    readonly projectId: string;
    readonly sourceFormat: ArticleWorkflowSourceFormat;
    readonly sourceText: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly platform: ArticleWorkflowPlatform;
    readonly theme: ArticleWorkflowThemeKey;
    readonly themeColor: string | null;
    readonly galleryMode: ArticleWorkflowGalleryMode;
    readonly currentHtml?: string;
    /** caption 平台改稿时的现有文案，等价于公众号链路的 currentHtml */
    readonly currentCaption?: string;
    readonly currentImages?: readonly ArticleWorkflowImageAsset[];
    readonly instruction?: string;
    readonly regenerateImages: boolean;
    readonly generateImages: boolean;
    readonly model: string;
    /** 写 ready 终态；返回 false 表示已被 reaper 抢占，reserve 将退款而非结算 */
    readonly commit: (result: MaterializedArticle) => Promise<boolean>;
  },
): Promise<MaterializedArticle> {
  const platformConfig = articleWorkflowPlatformConfig(args.platform);
  // 已扣款的图片 operationId：整单没能交付（抛错或终态被 reaper 抢占）就逐个退回，
  // 收集器放在 work 之外，图片批次自身抛错时也不丢清单
  const chargedImageOperationIds: string[] = [];
  const refundChargedImages = async (): Promise<void> => {
    for (const operationId of chargedImageOperationIds) {
      await args.billing.refundResource(operationId).catch(() => undefined);
    }
  };
  return runReservedArticleTextTask({
    billing: args.billing,
    commitResult: async (result) => {
      const committed = await args.commit(result);
      // reaper 已把项目置 failed，成品不会交付给用户，图片费同样要退
      if (!committed) await refundChargedImages();
      return committed;
    },
    userId: args.userId,
    projectId: args.projectId,
    units: estimateArticleWorkflowReserveUnits({
      sourceText: args.sourceText,
      creationConfig: args.creationConfig,
      currentHtml: args.currentHtml,
      currentCaption: args.currentCaption,
      instruction: args.instruction,
    }),
    // 落库供 reaper 在进程崩溃后退款；终态写入时清空
    onReserved: async (operationId) => {
      await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
        billingOperationId: operationId,
      });
    },
    work: async () => {
      const populateImages: PopulateArticleImages = ({ imageManifest, onProgress }) =>
        populateArticleWorkflowImages({
          prisma: args.prisma,
          billing: args.billing,
          fetchFn: args.fetchFn,
          env: args.env,
          userId: args.userId,
          projectId: args.projectId,
          imageManifest,
          platformConfig,
          force: args.regenerateImages,
          onCharged: (operationId) => chargedImageOperationIds.push(operationId),
          onProgress,
        });

      try {
        if (platformConfig.outputKind === "caption") {
          return await materializeCaptionArticle({
            creationConfig: args.creationConfig,
            prisma: args.prisma,
            llm: args.llm,
            model: args.model,
            projectId: args.projectId,
            platform: args.platform,
            platformConfig,
            sourceFormat: args.sourceFormat,
            sourceText: args.sourceText,
            currentCaption: args.currentCaption,
            currentImages: args.currentImages,
            regenerateImages: args.regenerateImages,
            generateImages: args.generateImages,
            instruction: args.instruction,
            populateImages,
          });
        }
        return await materializeHtmlFragmentArticle({ ...args, platformConfig, populateImages });
      } catch (error) {
        // 整单失败：已扣的图片费逐个退回（billing 按 operationId 幂等），再重抛给外层置 failed
        await refundChargedImages();
        throw error;
      }
    },
  });
}

async function materializeHtmlFragmentArticle(
  args: RunnerDeps & {
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
  // 正文里要剥掉的标题只认「模型确实在素材里找到的那个」（rawPlan.title）。
  // 兜底推导出来的标题不参与剥离：它取自正文首行，一旦拿去做精确匹配，
  // 单段素材会把唯一一段正文当标题剥空。展示用 plan.title，剥离用 rawPlan.title。
  const bodyMarkdown =
    args.generationMode === "preserve-text"
      ? preservedBodyMarkdown({
          sourceFormat: args.sourceFormat,
          sourceText: args.sourceText,
          currentHtml: args.currentHtml,
          title: rawPlan.title,
        })
      : plan.bodyMarkdown;
  const bodyVisibleText = articleWorkflowVisibleTextFromMarkdown(bodyMarkdown);
  assertArticleWorkflowImitationOriginality({
    creationConfig: args.creationConfig,
    outputText: [plan.title, plan.summary, bodyVisibleText].join("\n"),
  });
  const expectedVisibleText =
    args.generationMode === "preserve-text"
      ? expectedPreservedVisibleText({
          sourceFormat: args.sourceFormat,
          sourceText: args.sourceText,
          currentHtml: args.currentHtml,
          title: rawPlan.title,
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
    progressStage: args.generateImages ? "illustrating" : "layout",
    progressPercent: args.generateImages ? 35 : 72,
    progressMessage: args.generateImages ? "AI 正在生成配图" : "AI 正在排版正文",
  });

  if (args.generateImages) {
    imageManifest = await args.populateImages({
      imageManifest,
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
  }

  await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
    progressStage: "layout",
    progressPercent: 80,
    progressMessage: "AI 正在排版正文",
    imageManifestJson: imageManifest,
  });

  // 非 auto 主题：确定性模板渲染（不调 LLM layout）；auto：走原 LLM 排版链路。
  // 两条链路产出后都要过 repair + assert 硬校验，图片回填方式不同：
  // - 确定性渲染把图片以 markdown 语法注入、渲染器输出内嵌 <img>，不需要 slot 回填；
  // - LLM 排版输出 slot 占位 section，需要 applyArticleImageManifestToHtml 回填真实图。
  const deterministicHtml = renderDeterministicArticleBodyHtmlGuarded({
    theme: args.theme,
    themeColor: args.themeColor,
    bodyMarkdown,
    imageManifest,
    galleryMode: args.galleryMode,
  });
  let bodyHtml: string;
  if (deterministicHtml !== null) {
    bodyHtml = deterministicHtml;
  } else {
    const rawHtml = await renderArticleWorkflowBodyHtml({
      llm: args.llm,
      model: args.model,
      bodyMarkdown,
      imageManifest,
    });
    // 先修到词汇表以内再硬校验：排版是最后一步，配图钱已经花了，
    // 不该因为模型多写一个 <h2> 就让整行 failed。修的都是不动可见文字的操作。
    const guardedHtml = assertArticleWorkflowHtmlFragment({
      html: repairArticleWorkflowHtmlFragment(rawHtml),
      expectedVisibleText: bodyVisibleText,
      requiredImageSlots: imageManifest.map((item) => item.slot),
    });
    bodyHtml = applyArticleImageManifestToHtml(guardedHtml, imageManifest);
  }

  return {
    title: plan.title,
    summary: plan.summary,
    bodyHtml,
    bodyMarkdown: deterministicHtml !== null ? bodyMarkdown : "",
    captionText: "",
    tags: [],
    imageManifest,
  };
}

export async function runInitialArticleWorkflowGeneration(
  args: RunnerDeps & {
    readonly creationConfig: ArticleWorkflowCreationConfig;
    readonly userId: string;
    readonly projectId: string;
    readonly sourceFormat: ArticleWorkflowSourceFormat;
    readonly sourceText: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly platform: ArticleWorkflowPlatform;
    readonly generateImages: boolean;
    readonly model: string;
    readonly theme: ArticleWorkflowThemeKey;
    readonly themeColor: string | null;
    readonly galleryMode: ArticleWorkflowGalleryMode;
  },
): Promise<void> {
  const captionPlatform = articleWorkflowPlatformConfig(args.platform).outputKind === "caption";
  try {
    await updateArticleWorkflowProjectState(args.prisma, args.projectId, {
      status: "generating",
      progressStage: "drafting",
      progressPercent: 12,
      progressMessage: captionPlatform ? "AI 正在写文案" : "AI 正在整理文章",
      error: null,
    });
    await materializeArticleWorkflow({
      ...args,
      currentHtml: "",
      currentCaption: "",
      currentImages: [],
      instruction: "",
      regenerateImages: true,
      generateImages: args.generateImages,
      commit: (result) =>
        commitReadyArticleProject(args.prisma, args.projectId, {
          progressMessage: captionPlatform ? "文案已生成" : "已生成完成",
          generationMode: args.generationMode,
          result,
        }),
    });
  } catch (error) {
    await finalizeFailedArticleProject(args.prisma, args.projectId, {
      progressMessage: "生成失败",
      error,
    });
  }
}

export async function runArticleWorkflowRewrite(
  args: RunnerDeps & {
    readonly project: ArticleProjectRow;
    readonly instruction: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly regenerateImages: boolean;
    readonly model: string;
  },
): Promise<void> {
  const current = readArticleWorkflowProject(args.project);
  // 平台由项目行决定，改稿请求不能换平台
  const platform = current.platform;
  const captionPlatform = articleWorkflowPlatformConfig(platform).outputKind === "caption";
  try {
    await updateArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "revising",
      progressStage: "drafting",
      progressPercent: 15,
      progressMessage: captionPlatform ? "AI 正在改文案" : "AI 正在改稿",
      error: null,
    });
    await materializeArticleWorkflow({
      ...args,
      creationConfig: current.creationConfig,
      userId: args.project.userId,
      projectId: args.project.id,
      sourceFormat: current.sourceFormat,
      sourceText: current.sourceText,
      platform,
      theme: current.theme,
      themeColor: current.themeColor,
      galleryMode: current.galleryMode,
      currentHtml: current.bodyHtml,
      currentCaption: current.captionText,
      currentImages: current.imageManifest,
      generateImages: args.regenerateImages,
      commit: (result) =>
        commitReadyArticleProject(args.prisma, args.project.id, {
          progressMessage: captionPlatform ? "文案已更新" : "改稿完成",
          generationMode: args.generationMode,
          result,
        }),
    });
  } catch (error) {
    await finalizeFailedArticleProject(args.prisma, args.project.id, {
      progressMessage: "改稿失败",
      error,
    });
  }
}

export async function runArticleWorkflowMissingImages(
  args: RunnerDeps & {
    readonly project: ArticleProjectRow;
  },
): Promise<void> {
  const current = readArticleWorkflowProject(args.project);
  const missing = current.imageManifest.filter((image) => !image.imageUrl.trim());
  if (missing.length === 0) {
    await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图已齐全",
      error: null,
    });
    return;
  }

  const chargedOperationIds: string[] = [];
  try {
    const imageManifest = await populateArticleWorkflowImages({
      prisma: args.prisma,
      billing: args.billing,
      fetchFn: args.fetchFn,
      env: args.env,
      userId: args.project.userId,
      projectId: args.project.id,
      imageManifest: current.imageManifest,
      platformConfig: articleWorkflowPlatformConfig(current.platform),
      force: false,
      onCharged: (operationId) => chargedOperationIds.push(operationId),
      onProgress: async (completed, total) => {
        await updateArticleWorkflowProjectState(args.prisma, args.project.id, {
          status: "revising",
          progressStage: "illustrating",
          progressPercent: 10 + Math.round((completed / Math.max(total, 1)) * 85),
          progressMessage: `正在生成配图（${completed}/${total}）`,
        });
      },
    });
    const platformConfig = articleWorkflowPlatformConfig(current.platform);
    // caption 平台没有正文 HTML；确定性主题（bodyMarkdown 非空）的公众号正文要按正文+新清单重渲，
    // 否则 slot 回填找不到占位符会退化成往末尾追加图片。
    const deterministicHtml = current.bodyMarkdown.trim()
      ? renderDeterministicArticleBodyHtmlGuarded({
          theme: current.theme,
          themeColor: current.themeColor,
          bodyMarkdown: current.bodyMarkdown,
          imageManifest,
          galleryMode: current.galleryMode,
        })
      : null;
    const bodyHtml =
      platformConfig.outputKind === "caption"
        ? current.bodyHtml
        : (deterministicHtml ?? applyArticleImageManifestToHtml(current.bodyHtml, imageManifest));
    const committed = await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, {
      bodyHtml,
      imageManifestJson: imageManifest,
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图已生成",
      error: null,
    });
    if (!committed) {
      for (const operationId of chargedOperationIds) {
        await args.billing.refundResource(operationId).catch(() => undefined);
      }
    }
  } catch (error) {
    for (const operationId of chargedOperationIds) {
      await args.billing.refundResource(operationId).catch(() => undefined);
    }
    await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图生成失败，可重新尝试",
      error: safeErrorMessage(error),
    }).catch(() => undefined);
  }
}
