import {
  articleWorkflowPlatformConfig,
  type ArticleWorkflowCreationConfig,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowImageAsset,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import type { PrismaClient } from "@prisma/client";
import { renderDeterministicArticleBodyHtmlGuarded } from "./article-workflow-deterministic.js";
import { applyArticleImageManifestToHtml } from "./article-workflow-image-manifest.js";
import { populateArticleWorkflowImages } from "./article-workflow-images.js";
import { materializeCaptionArticle } from "./article-workflow-runner-caption.js";
import { materializeHtmlFragmentArticle } from "./article-workflow-runner-html.js";
import { readArticleWorkflowProject } from "./article-workflow-serializer.js";
import type { ArticleProjectRow, ArticleWorkflowRouteDeps } from "./article-workflow-shared.js";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import {
  ArticleWorkflowLeaseLostError,
  finalizeArticleWorkflowProjectState,
  type ArticleWorkflowProjectStatePatch,
  writeArticleWorkflowRunState,
} from "./article-workflow-store.js";

type RunnerDeps = Required<Pick<ArticleWorkflowRouteDeps, "llm" | "fetchFn" | "env">> & {
  readonly prisma: PrismaClient;
};

interface ArticleRunLease {
  version: Date;
}

export type UpdateArticleProgress = (patch: ArticleWorkflowProjectStatePatch) => Promise<void>;

async function updateRunState(
  prisma: PrismaClient,
  projectId: string,
  lease: ArticleRunLease,
  patch: ArticleWorkflowProjectStatePatch,
): Promise<void> {
  lease.version = await writeArticleWorkflowRunState(prisma, projectId, lease.version, patch);
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
 * 由 materializeArticleWorkflow 注入，内部已绑好平台配置——
 * caption 链路不允许自己再调一次 populateArticleWorkflowImages。
 */
export type PopulateArticleImages = (args: {
  readonly imageManifest: readonly ArticleWorkflowImageAsset[];
  readonly onProgress: (completed: number, total: number) => Promise<void>;
}) => Promise<readonly ArticleWorkflowImageAsset[]>;

async function commitReadyArticleProject(
  prisma: PrismaClient,
  projectId: string,
  lease: ArticleRunLease,
  args: {
    readonly progressMessage: string;
    readonly generationMode: ArticleWorkflowGenerationMode;
    readonly result: MaterializedArticle;
  },
): Promise<boolean> {
  const committed = await finalizeArticleWorkflowProjectState(prisma, projectId, lease.version, {
    status: "ready",
    progressStage: "ready",
    progressPercent: 100,
    progressMessage: args.progressMessage,
    error: null,
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
  lease: ArticleRunLease,
  args: { readonly progressMessage: string; readonly error: unknown },
): Promise<void> {
  if (args.error instanceof ArticleWorkflowLeaseLostError) return;
  const committed = await finalizeArticleWorkflowProjectState(prisma, projectId, lease.version, {
    status: "failed",
    progressStage: "failed",
    progressPercent: 100,
    progressMessage: args.progressMessage,
    error: errorMessageOrFallback(args.error, "文章生成失败"),
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
    readonly lease: ArticleRunLease;
    /** 写 ready 终态；返回 false 表示已被 reaper 抢占，成品不再交付给用户 */
    readonly commit: (result: MaterializedArticle) => Promise<boolean>;
  },
): Promise<MaterializedArticle> {
  const platformConfig = articleWorkflowPlatformConfig(args.platform);
  const updateProgress: UpdateArticleProgress = (patch) =>
    updateRunState(args.prisma, args.projectId, args.lease, patch);
  const populateImages: PopulateArticleImages = ({ imageManifest, onProgress }) =>
    populateArticleWorkflowImages({
      prisma: args.prisma,
      fetchFn: args.fetchFn,
      env: args.env,
      userId: args.userId,
      projectId: args.projectId,
      imageManifest,
      platformConfig,
      force: args.regenerateImages,
      onProgress,
    });

  const result =
    platformConfig.outputKind === "caption"
      ? await materializeCaptionArticle({
          creationConfig: args.creationConfig,
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
          updateProgress,
        })
      : await materializeHtmlFragmentArticle({ ...args, platformConfig, populateImages, updateProgress });
  // 终态写入受 reaper 抢占保护：commit 返回 false 时不再写，失败现场留给用户
  await args.commit(result);
  return result;
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
    readonly runVersion: Date;
  },
): Promise<void> {
  const captionPlatform = articleWorkflowPlatformConfig(args.platform).outputKind === "caption";
  const lease: ArticleRunLease = { version: args.runVersion };
  try {
    await updateRunState(args.prisma, args.projectId, lease, {
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
      lease,
      commit: (result) =>
        commitReadyArticleProject(args.prisma, args.projectId, lease, {
          progressMessage: captionPlatform ? "文案已生成" : "已生成完成",
          generationMode: args.generationMode,
          result,
        }),
    });
  } catch (error) {
    await finalizeFailedArticleProject(args.prisma, args.projectId, lease, {
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
    readonly runVersion: Date;
  },
): Promise<void> {
  const current = readArticleWorkflowProject(args.project);
  // 平台由项目行决定，改稿请求不能换平台
  const platform = current.platform;
  const captionPlatform = articleWorkflowPlatformConfig(platform).outputKind === "caption";
  const lease: ArticleRunLease = { version: args.runVersion };
  try {
    await updateRunState(args.prisma, args.project.id, lease, {
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
      lease,
      commit: (result) =>
        commitReadyArticleProject(args.prisma, args.project.id, lease, {
          progressMessage: captionPlatform ? "文案已更新" : "改稿完成",
          generationMode: args.generationMode,
          result,
        }),
    });
  } catch (error) {
    await finalizeFailedArticleProject(args.prisma, args.project.id, lease, {
      progressMessage: "改稿失败",
      error,
    });
  }
}

export async function runArticleWorkflowMissingImages(
  args: RunnerDeps & {
    readonly project: ArticleProjectRow;
    readonly runVersion: Date;
  },
): Promise<void> {
  const current = readArticleWorkflowProject(args.project);
  const lease: ArticleRunLease = { version: args.runVersion };
  const missing = current.imageManifest.filter((image) => !image.imageUrl.trim());
  if (missing.length === 0) {
    await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, lease.version, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图已齐全",
      error: null,
    });
    return;
  }

  try {
    const imageManifest = await populateArticleWorkflowImages({
      prisma: args.prisma,
      fetchFn: args.fetchFn,
      env: args.env,
      userId: args.project.userId,
      projectId: args.project.id,
      imageManifest: current.imageManifest,
      platformConfig: articleWorkflowPlatformConfig(current.platform),
      force: false,
      onProgress: async (completed, total) => {
        await updateRunState(args.prisma, args.project.id, lease, {
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
    await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, lease.version, {
      bodyHtml,
      imageManifestJson: imageManifest,
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图已生成",
      error: null,
    });
  } catch (error) {
    if (error instanceof ArticleWorkflowLeaseLostError) return;
    await finalizeArticleWorkflowProjectState(args.prisma, args.project.id, lease.version, {
      status: "ready",
      progressStage: "ready",
      progressPercent: 100,
      progressMessage: "配图生成失败，可重新尝试",
      error: errorMessageOrFallback(error, "配图生成失败"),
    }).catch(() => undefined);
  }
}
