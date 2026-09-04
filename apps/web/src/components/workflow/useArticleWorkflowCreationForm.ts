/**
 * 图文工坊的创作表单层:新建输入(原文/主题)、平台勾选、生成时的主题选择,
 * 以及**预览态换肤**那三份「试看中」的值。
 *
 * 从 `useArticleWorkflowStudio.ts` 原样搬出。两处不能动的语义:
 *  - **预览态和项目态是两套值**。`previewTheme` 等为 null 表示跟随项目主题,非 null 表示
 *    正在试看/已选未应用;真正落库要点「应用主题」,那一步走后端重渲。
 *  - **切项目要把预览态清掉**,否则上一篇的试看主题会盖在下一篇的预览上。
 *  - 平台勾选**保持固定顺序**且至少留一个:勾选顺序不该影响生成顺序,全取消没有意义。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ARTICLE_WORKFLOW_PLATFORMS,
  type ArticleWorkflowGalleryMode,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowThemeKey,
} from "@ai-assistant/article-workflow";
import type { ArticleWorkflowProject } from "../../workflowArticleApi";
import {
  articleWorkflowCreationDraftFromProject,
  defaultArticleWorkflowCreationDraft,
  type ArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";

export function useArticleWorkflowCreationForm(args: {
  readonly initialProject: ArticleWorkflowProject | null;
  readonly activeProjectId: string | undefined;
  /** 任何一次表单改动都要把上一次的报错/提示清掉 */
  readonly onEdit: () => void;
}) {
  const { initialProject, activeProjectId, onEdit } = args;
  const [creationDraft, setCreationDraft] = useState<ArticleWorkflowCreationDraft>(
    initialProject ? articleWorkflowCreationDraftFromProject(initialProject) : defaultArticleWorkflowCreationDraft(),
  );
  const [generateImages, setGenerateImages] = useState(initialProject?.creationConfig.generateImages ?? true);
  const [generationMode, setGenerationMode] = useState<ArticleWorkflowGenerationMode>(
    initialProject?.generationMode ?? "preserve-text",
  );
  const [selectedPlatforms, setSelectedPlatforms] = useState<readonly ArticleWorkflowPlatform[]>(
    initialProject ? [initialProject.platform] : ARTICLE_WORKFLOW_PLATFORMS,
  );
  const [selectedTheme, setSelectedTheme] = useState<ArticleWorkflowThemeKey>("auto");
  const [selectedThemeColor, setSelectedThemeColor] = useState("");
  const [selectedGalleryMode, setSelectedGalleryMode] = useState<ArticleWorkflowGalleryMode>("collage");
  /** 预览态换肤：null 表示跟随项目主题，非 null 表示正在试看/已选未应用 */
  const [previewTheme, setPreviewTheme] = useState<ArticleWorkflowThemeKey | null>(null);
  const [previewThemeColor, setPreviewThemeColor] = useState<string | null>(null);
  const [previewGalleryMode, setPreviewGalleryMode] = useState<ArticleWorkflowGalleryMode | null>(null);

  const clearPreviewTheme = useCallback(() => {
    setPreviewTheme(null);
    setPreviewThemeColor(null);
    setPreviewGalleryMode(null);
  }, []);

  // 切换项目后重置预览态换肤，回到「跟随项目主题」
  useEffect(() => {
    setPreviewTheme(null);
    setPreviewThemeColor(null);
    setPreviewGalleryMode(null);
  }, [activeProjectId]);

  /**
   * 批次载入(force=true)时把新建表单也拉回这个批次的配置。
   *
   * 身份必须稳定:主控里的 `hydrateProjects` → `loadBatch` → 批次轮询 effect 是一条
   * 依赖链,这个函数每次渲染换新身份就会让 2.5s 的轮询定时器每次渲染重建一次,等于永不发车。
   */
  const hydrateFromBatch = useCallback((details: readonly ArticleWorkflowProject[]) => {
    const sourceProject = details[0];
    if (!sourceProject) return;
    setCreationDraft(articleWorkflowCreationDraftFromProject(sourceProject));
    setGenerateImages(sourceProject.creationConfig.generateImages);
    setGenerationMode(sourceProject.generationMode);
    setSelectedPlatforms(
      ARTICLE_WORKFLOW_PLATFORMS.filter((item) => details.some((detail) => detail.platform === item)),
    );
  }, []);

  const reset = useCallback(() => {
    setCreationDraft(defaultArticleWorkflowCreationDraft());
    setGenerateImages(true);
    setGenerationMode("preserve-text");
    setSelectedPlatforms(ARTICLE_WORKFLOW_PLATFORMS);
  }, []);

  const handleTogglePlatform = (target: ArticleWorkflowPlatform) => {
    setSelectedPlatforms((current) => {
      if (!current.includes(target)) {
        // 保持平台的固定顺序，勾选顺序不影响生成顺序
        return ARTICLE_WORKFLOW_PLATFORMS.filter((item) => item === target || current.includes(item));
      }
      // 至少留一个平台，全取消没有意义
      if (current.length === 1) return current;
      return current.filter((item) => item !== target);
    });
    onEdit();
  };

  return {
    creationDraft,
    generateImages,
    generationMode,
    selectedPlatforms,
    selectedTheme,
    selectedThemeColor,
    selectedGalleryMode,
    previewTheme,
    previewThemeColor,
    previewGalleryMode,
    setGenerationMode,
    clearPreviewTheme,
    hydrateFromBatch,
    reset,
    handleTogglePlatform,
    handlers: {
      setCreationDraft: (value: ArticleWorkflowCreationDraft) => {
        setCreationDraft(value);
        onEdit();
      },
      handleCreationModeChange: (mode: ArticleWorkflowCreationDraft["mode"]) => {
        setCreationDraft(defaultArticleWorkflowCreationDraft(mode));
        setGenerateImages(mode === "source");
        setGenerationMode(mode === "source" ? "preserve-text" : "polish-text");
        onEdit();
      },
      setGenerateImages: (value: boolean) => {
        setGenerateImages(value);
        onEdit();
      },
      onThemeChange: (value: ArticleWorkflowThemeKey) => {
        setSelectedTheme(value);
        onEdit();
      },
      onThemeColorChange: (value: string) => {
        setSelectedThemeColor(value);
        onEdit();
      },
      onGalleryModeChange: (value: ArticleWorkflowGalleryMode) => {
        setSelectedGalleryMode(value);
        onEdit();
      },
      onPreviewThemeChange: (value: ArticleWorkflowThemeKey) => {
        setPreviewTheme(value);
        onEdit();
      },
      onPreviewThemeColorChange: (value: string) => {
        setPreviewThemeColor(value);
        onEdit();
      },
      onPreviewGalleryModeChange: (value: ArticleWorkflowGalleryMode) => {
        setPreviewGalleryMode(value);
        onEdit();
      },
      onResetPreviewTheme: () => {
        clearPreviewTheme();
        onEdit();
      },
    },
  };
}
