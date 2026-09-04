/**
 * 图文工坊的主控。四个子层拆出去之后这里只剩「批次 + 项目 + 动作」:
 *  - 草稿 / 脏标记 / hash 基线 → `useArticleWorkflowDrafts`
 *  - 新建表单 + 预览态换肤 → `useArticleWorkflowCreationForm`
 *  - 批次轮询 → `useArticleWorkflowBatchPolling`
 *  - 手动保存 + 自动保存 + 409 竞态 → `useArticleWorkflowSave`
 *
 * 返回值仍然是**一个扁平对象**:`ArticleWorkflowStudio.tsx` 和 DOM 侧的两个测试文件直接按名
 * 取值,拆分不允许改这层形状。
 *
 * 传给子 hook 的回调必须是稳定身份(`useCallback`)。`hydrateProjects → loadBatch → 轮询 effect`
 * 是一条依赖链,链上任何一环每次渲染换新身份,2.5s 的轮询定时器就会被反复重建,等于永不发车。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { useToast } from "../../motion";
import {
  applyArticleWorkflowTheme,
  createArticleWorkflowProject,
  deleteArticleWorkflowProject,
  generateArticleWorkflowImages,
  getArticleWorkflowBatch,
  getArticleWorkflowProject,
  listArticleWorkflowHistory,
  regenerateArticleWorkflowImage,
  retryArticleWorkflowProject,
  rewriteArticleWorkflowProject,
  type ArticleWorkflowProject,
  type ArticleWorkflowProjectSummary,
} from "../../workflowArticleApi";
import {
  articleWorkflowCreationConfigFromDraft,
  canSubmitArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";
import {
  articleWorkflowBatchProgress,
  groupArticleWorkflowHistory,
  resolveActiveArticleWorkflowProject,
  type ArticleWorkflowBatchEntry,
} from "./articleWorkflowBatchModel";
import { createArticleWorkflowCopyActions } from "./articleWorkflowCopyActions";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import {
  articleWorkflowDraftHash,
  canSaveArticleWorkflowStatus,
  cloneImageManifest,
  isBusyArticleWorkflowStatus,
} from "./articleWorkflowStudioModel";
import {
  useArticleWorkflowBatchPolling,
  type ArticleWorkflowLoadBatchArgs,
} from "./useArticleWorkflowBatchPolling";
import { useArticleWorkflowCreationForm } from "./useArticleWorkflowCreationForm";
import { useArticleWorkflowDrafts } from "./useArticleWorkflowDrafts";
import { useArticleWorkflowSave } from "./useArticleWorkflowSave";

export interface ArticleWorkflowBatchSelection {
  readonly key: string;
  readonly batchId: string | null;
  readonly projectId: string;
}

function withClonedManifest(project: ArticleWorkflowProject): ArticleWorkflowProject {
  return { ...project, imageManifestJson: cloneImageManifest(project.imageManifestJson) };
}

export function useArticleWorkflowStudio({
  token,
  initialHistory,
  initialProject = null,
  initialBootstrapping,
}: ArticleWorkflowStudioProps) {
  const toast = useToast();
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const [editorSyncKey, setEditorSyncKey] = useState("");
  const [bootstrapping, setBootstrapping] = useState(initialBootstrapping ?? !initialHistory);
  const [history, setHistory] = useState<readonly ArticleWorkflowProjectSummary[]>(initialHistory ?? []);
  const [batchProjects, setBatchProjects] = useState<readonly ArticleWorkflowProject[]>(
    initialProject ? [initialProject] : [],
  );
  const [activePlatform, setActivePlatform] = useState<ArticleWorkflowPlatform | null>(
    initialProject?.platform ?? null,
  );
  const [applyingTheme, setApplyingTheme] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  /** 正在重试的行 id，用来禁用按钮防重复点击 */
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(null);
  const [deletingBatchKey, setDeletingBatchKey] = useState<string | null>(null);
  const [regeneratingSlot, setRegeneratingSlot] = useState<string | null>(null);
  const [generatingImageProjectIds, setGeneratingImageProjectIds] = useState<readonly string[]>([]);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteGenerationMode, setRewriteGenerationMode] = useState<ArticleWorkflowGenerationMode>(
    initialProject?.generationMode ?? "preserve-text",
  );
  const [rewriteRegenerateImages, setRewriteRegenerateImages] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  /** 任何一次用户操作都要把上一次的报错/提示清掉。身份要稳：它是创作表单的 onEdit */
  const resetMessages = useCallback(() => {
    setError("");
    setNotice("");
  }, []);

  const drafts = useArticleWorkflowDrafts({ initialProject, batchProjects });
  const { dirtyPlatforms, draftsFor, editDraft, hashOf, hydrateDrafts, markDirty, noteSaved } = drafts;

  const project = useMemo(
    () => resolveActiveArticleWorkflowProject(batchProjects, activePlatform),
    [activePlatform, batchProjects],
  );
  const platform = project?.platform ?? "wechat";
  const platformConfig = articleWorkflowPlatformConfig(platform);
  const captionPlatform = platformConfig.outputKind === "caption";
  const selectedBatchKey = project ? (project.batchId ? `batch:${project.batchId}` : `project:${project.id}`) : null;
  const dirty = dirtyPlatforms.includes(platform);
  const anyDirty = dirtyPlatforms.length > 0;
  /** 只有成品行能存；failed / 生成中的行连脏标记都不打，自动保存自然不会启动 */
  const savable = canSaveArticleWorkflowStatus(project?.status);

  /**
   * 当前平台的五个草稿值。这里必须 memo：`tags` 缺省时是 `[]` 字面量，每次渲染都是新数组，
   * 直接往保存层传会让自动保存的 1.5s 计时器每次渲染重置一次。
   */
  const activeDrafts = useMemo(() => draftsFor(platform), [draftsFor, platform]);
  const titleDraft = activeDrafts.title;
  const summaryDraft = activeDrafts.summary;
  const bodyHtmlDraft = activeDrafts.bodyHtml;
  const captionDraft = activeDrafts.captionText;
  const tagsDraft = activeDrafts.tags;

  const creationForm = useArticleWorkflowCreationForm({
    initialProject,
    activeProjectId: project?.id,
    onEdit: resetMessages,
  });
  const { creationDraft, generateImages, generationMode, selectedPlatforms } = creationForm;
  const sourceFormat: ArticleWorkflowSourceFormat =
    creationDraft.mode === "source" ? creationDraft.sourceFormat : "plain-text";
  const sourceText = creationDraft.mode === "source" ? creationDraft.sourceText : "";

  const historyBatches = useMemo(() => groupArticleWorkflowHistory(history), [history]);
  const batchProgress = useMemo(() => articleWorkflowBatchProgress(batchProjects), [batchProjects]);
  const batchBusy = batchProjects.some((item) => isBusyArticleWorkflowStatus(item.status));

  /** 单行的服务端值回写批次（图片 manifest 深拷贝，避免共享引用被就地改） */
  const replaceProjectRow = useCallback((next: ArticleWorkflowProject) => {
    setBatchProjects((current) => current.map((item) => (item.id === next.id ? withClonedManifest(next) : item)));
  }, []);

  /**
   * 把批次的服务端状态写回草稿与新建表单。
   * force=false 时保留仍在编辑的平台草稿（生成中的行没有用户改动，一律覆盖）。
   */
  const { hydrateFromBatch } = creationForm;
  const hydrateProjects = useCallback(
    (
      details: readonly ArticleWorkflowProject[],
      args?: { readonly force?: boolean; readonly focusPlatform?: ArticleWorkflowPlatform | null },
    ) => {
      const force = args?.force ?? true;
      setBatchProjects(details.map(withClonedManifest));
      if (force) hydrateFromBatch(details);
      hydrateDrafts(details, force);

      const requestedFocus = args?.focusPlatform ?? null;
      const inBatch = details.some((item) => item.platform === activePlatform);
      const focus = requestedFocus ?? (inBatch ? activePlatform : null);
      const focused = resolveActiveArticleWorkflowProject(details, focus);
      if (focused) {
        setActivePlatform(focused.platform);
        setRewriteGenerationMode(focused.generationMode);
        setEditorSyncKey(`${focused.id}:${hashOf(focused.platform) ?? ""}`);
      }
      return details;
    },
    [activePlatform, hashOf, hydrateDrafts, hydrateFromBatch],
  );

  const refreshHistory = useCallback(async () => {
    setHistory(await listArticleWorkflowHistory(token));
  }, [token]);

  /** 批次载入；存量无 batchId 的行退回单项目接口 */
  const loadBatch = useCallback(
    async (args: ArticleWorkflowLoadBatchArgs) => {
      const details = args.batchId
        ? (await getArticleWorkflowBatch(token, args.batchId)).projects
        : [await getArticleWorkflowProject(token, args.projectId)];
      return hydrateProjects(details, {
        force: args.force ?? true,
        focusPlatform: args.focusPlatform ?? (args.batchId ? null : (details[0]?.platform ?? null)),
      });
    },
    [hydrateProjects, token],
  );

  // 服务端直出的首个项目也要先立 hash 基线，否则编辑器载入的规范化回写会被当成用户编辑
  useEffect(() => {
    if (initialProject) {
      setEditorSyncKey(`${initialProject.id}:${noteSaved(initialProject)}`);
    }
  }, [initialProject, noteSaved]);

  useEffect(() => {
    if (initialHistory) {
      setBootstrapping(false);
      return;
    }
    void (async () => {
      try {
        await refreshHistory();
      } catch {
        setError("加载图文工作台失败");
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [initialHistory, refreshHistory]);

  useArticleWorkflowBatchPolling({
    batchProjects,
    batchBusy,
    loadBatch,
    refreshHistory,
    setError,
    setNotice,
  });

  const { saving, saveProject } = useArticleWorkflowSave({
    token,
    project,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    captionDraft,
    tagsDraft,
    dirty,
    rewriting,
    hashOf,
    markDirty,
    noteSaved,
    replaceProjectRow,
    refreshHistory,
    setError,
    setNotice,
    toast,
  });

  const canGenerate = canSubmitArticleWorkflowCreationDraft(creationDraft) && selectedPlatforms.length > 0 && !creating;
  const canSave = Boolean(project && dirty && savable && !saving);
  const canRewrite = Boolean(
    project && rewriteInstruction.trim() && !rewriting && !saving && !isBusyArticleWorkflowStatus(project.status),
  );

  const { handleCopyBody, handleCopyTitle, handleCopySummary, handleCopyCaption, handleCopyTags } =
    createArticleWorkflowCopyActions({
      previewBodyRef,
      titleDraft,
      summaryDraft,
      bodyHtmlDraft,
      captionDraft,
      tagsDraft,
      toast,
      setError,
      setNotice,
    });

  const ensureCanLeaveDirty = () => {
    if (!anyDirty) return true;
    return typeof window === "undefined" || window.confirm("当前有未保存修改，确定切换项目吗？");
  };

  const resetToNewProject = () => {
    setBatchProjects([]);
    setActivePlatform(null);
    drafts.resetDrafts();
    setEditorSyncKey("");
    creationForm.reset();
    setRewriteInstruction("");
    setRewriteGenerationMode("preserve-text");
    setRewriteRegenerateImages(false);
    resetMessages();
  };

  const handleNewProject = () => {
    if (!ensureCanLeaveDirty()) return;
    resetToNewProject();
  };

  const handleSelectBatch = (entry: ArticleWorkflowBatchSelection) => {
    if (entry.key === selectedBatchKey || !ensureCanLeaveDirty()) return;
    void (async () => {
      try {
        resetMessages();
        drafts.clearDirty();
        setActivePlatform(null);
        await loadBatch({ batchId: entry.batchId, projectId: entry.projectId, force: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载项目失败");
      }
    })();
  };

  const handleDeleteBatch = (entry: ArticleWorkflowBatchEntry) => {
    if (deletingBatchKey || entry.status === "busy") return;
    const title = entry.title || "未命名图文";
    if (
      typeof window !== "undefined" &&
      !window.confirm(`确定删除“${title}”吗？该批次下的所有平台内容都会被删除，且无法恢复。`)
    )
      return;
    setDeletingBatchKey(entry.key);
    resetMessages();
    void (async () => {
      try {
        await deleteArticleWorkflowProject(token, entry.projectId);
        setHistory((current) =>
          current.filter((item) => (entry.batchId ? item.batchId !== entry.batchId : item.id !== entry.projectId)),
        );
        if (entry.key === selectedBatchKey) resetToNewProject();
        toast.show("ok", "项目已删除");
      } catch (err) {
        const message = err instanceof Error ? err.message : "删除项目失败";
        setError(message);
        toast.show("err", message);
        await refreshHistory().catch(() => undefined);
      } finally {
        setDeletingBatchKey(null);
      }
    })();
  };

  const handleSelectPlatform = (next: ArticleWorkflowPlatform) => {
    if (next === activePlatform) return;
    const target = batchProjects.find((item) => item.platform === next);
    if (!target) return;
    setActivePlatform(next);
    setRewriteGenerationMode(target.generationMode);
    setEditorSyncKey(`${target.id}:${hashOf(next) ?? ""}`);
    resetMessages();
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    setCreating(true);
    resetMessages();
    void (async () => {
      try {
        const creationConfig = articleWorkflowCreationConfigFromDraft(creationDraft, generateImages);
        const created = await createArticleWorkflowProject(token, {
          creationMode: creationDraft.mode,
          creationConfig,
          sourceFormat,
          sourceText: sourceText.trim(),
          generationMode: creationDraft.mode === "topic" ? "polish-text" : generationMode,
          platforms: selectedPlatforms,
          generateImages,
          theme: creationForm.selectedTheme,
          themeColor: creationForm.selectedThemeColor || null,
          galleryMode: creationForm.selectedGalleryMode,
        });
        drafts.clearDirty();
        const details = await loadBatch({
          batchId: created.batchId,
          projectId: created.projectId,
          force: true,
          focusPlatform: created.projects[0]?.platform ?? null,
        });
        await refreshHistory();
        setNotice(`已开始生成 ${details.length} 个平台的${generateImages ? "图文" : "文案"}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "创建图文项目失败");
      } finally {
        setCreating(false);
      }
    })();
  };

  const handleRewrite = () => {
    if (!project || !canRewrite) return;
    const current = project;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setRewriting(true);
      resetMessages();
      try {
        await rewriteArticleWorkflowProject(token, current.id, {
          instruction: rewriteInstruction.trim(),
          generationMode: rewriteGenerationMode,
          regenerateImages: rewriteRegenerateImages,
        });
        await loadBatch({
          batchId: current.batchId,
          projectId: current.id,
          force: true,
          focusPlatform: current.platform,
        });
        setRewriteInstruction("");
        setNotice("已提交重新生成");
        toast.show("ok", "已提交重新生成");
        await refreshHistory();
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI 重新生成失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRewriting(false);
      }
    })();
  };

  /** 失败行重试：走 retry 端点重跑首轮生成，之后交给现有轮询跟到终态 */
  const handleRetry = (projectId: string) => {
    const target = batchProjects.find((item) => item.id === projectId);
    if (!target || target.status !== "failed" || retryingProjectId) return;
    setRetryingProjectId(projectId);
    resetMessages();
    void (async () => {
      try {
        await retryArticleWorkflowProject(token, projectId);
        // force=false：别把其他平台正在编辑的草稿冲掉；重试行本身是生成中，会被服务端值覆盖
        await loadBatch({
          batchId: target.batchId,
          projectId,
          force: false,
          focusPlatform: project?.platform ?? target.platform,
        });
        await refreshHistory();
        setNotice("已重新开始生成");
        toast.show("ok", "已重新开始生成");
      } catch (err) {
        const message = err instanceof Error ? err.message : "重新生成失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRetryingProjectId(null);
      }
    })();
  };

  const handleRegenerateImage = (slot: string) => {
    if (!project) return;
    const current = project;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setRegeneratingSlot(slot);
      resetMessages();
      try {
        const updated = await regenerateArticleWorkflowImage(token, current.id, slot, {});
        replaceProjectRow(updated);
        // 服务端重渲过正文：新值即新基线，草稿直接跟过去，不留脏标记
        const hash = noteSaved(updated);
        drafts.writeDrafts(current.platform, { bodyHtml: updated.bodyHtml });
        setEditorSyncKey(`${updated.id}:${hash}`);
        setNotice("图片已更新");
        toast.show("ok", "图片已更新");
        await refreshHistory();
      } catch (err) {
        const message = err instanceof Error ? err.message : "图片重生失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRegeneratingSlot(null);
      }
    })();
  };

  const handleGenerateImages = (scope: "current" | "batch") => {
    if (!project || generatingImageProjectIds.length > 0) return;
    const targets = (scope === "current" ? [project] : batchProjects).filter(
      (item) => item.status === "ready" && item.imageManifestJson.some((image) => !image.imageUrl.trim()),
    );
    if (targets.length === 0) return;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setGeneratingImageProjectIds(targets.map((item) => item.id));
      resetMessages();
      try {
        const results = await Promise.allSettled(targets.map((item) => generateArticleWorkflowImages(token, item.id)));
        const rejected = results.filter((result) => result.status === "rejected");
        await loadBatch({
          batchId: project.batchId,
          projectId: project.id,
          force: false,
          focusPlatform: project.platform,
        });
        await refreshHistory();
        if (rejected.length > 0) {
          setError(`${rejected.length} 个平台提交配图失败`);
        } else {
          setNotice(scope === "current" ? "已开始生成当前平台配图" : `已开始生成 ${targets.length} 个平台配图`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "生成配图失败");
      } finally {
        setGeneratingImageProjectIds([]);
      }
    })();
  };

  /** 应用预览态主题到项目：后端按 bodyMarkdown + 新主题重渲正文。 */
  const handleApplyTheme = () => {
    if (!project) return;
    const theme = creationForm.previewTheme ?? project.theme;
    const themeColor = (creationForm.previewThemeColor ?? project.themeColor) || null;
    const galleryMode = creationForm.previewGalleryMode ?? project.galleryMode;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setApplyingTheme(true);
      resetMessages();
      try {
        const updated = await applyArticleWorkflowTheme(token, project.id, { theme, themeColor, galleryMode });
        replaceProjectRow(updated);
        // 换肤是服务端重渲，新正文即新基线；预览态到这里才清掉
        const hash = noteSaved(updated);
        drafts.writeDrafts(project.platform, { bodyHtml: updated.bodyHtml });
        setEditorSyncKey(`${updated.id}:${hash}`);
        creationForm.clearPreviewTheme();
        setNotice("主题已应用");
        toast.show("ok", "主题已应用");
        await refreshHistory();
      } catch (err) {
        const message = err instanceof Error ? err.message : "应用主题失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setApplyingTheme(false);
      }
    })();
  };

  return {
    bootstrapping,
    history,
    historyBatches,
    selectedBatchKey,
    batchProjects,
    batchProgress,
    batchBusy,
    activePlatform: project?.platform ?? null,
    platformConfig,
    captionPlatform,
    creationDraft,
    generateImages,
    selectedPlatforms,
    dirtyPlatforms,
    project,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    captionDraft,
    tagsDraft,
    editorSyncKey,
    sourceFormat,
    generationMode,
    sourceText,
    creating,
    saving,
    rewriting,
    retryingProjectId,
    deletingBatchKey,
    regeneratingSlot,
    generatingImageProjectIds,
    rewriteInstruction,
    rewriteGenerationMode,
    rewriteRegenerateImages,
    error,
    notice,
    dirty,
    previewBodyRef,
    canGenerate,
    canSave,
    canRewrite,
    setGenerationMode: creationForm.setGenerationMode,
    selectedTheme: creationForm.selectedTheme,
    selectedThemeColor: creationForm.selectedThemeColor,
    selectedGalleryMode: creationForm.selectedGalleryMode,
    previewTheme: creationForm.previewTheme,
    previewThemeColor: creationForm.previewThemeColor,
    previewGalleryMode: creationForm.previewGalleryMode,
    applyingTheme,
    // 创作表单/换肤的那批 setter 自带「改动即清提示」，原样透出
    ...creationForm.handlers,
    handleApplyTheme,
    setRewriteInstruction,
    setRewriteGenerationMode,
    setRewriteRegenerateImages,
    handleNewProject,
    handleSelectBatch,
    handleDeleteBatch,
    handleSelectPlatform,
    handleTogglePlatform: creationForm.handleTogglePlatform,
    handleGenerate,
    handleSave: () => saveProject("manual"),
    handleCopyBody,
    handleCopyTitle,
    handleCopySummary,
    handleCopyCaption,
    handleCopyTags,
    handleRewrite,
    handleRetry,
    handleRegenerateImage,
    handleGenerateImages,
    markTitleDirty: (value: string) => {
      editDraft(platform, { title: value });
      resetMessages();
    },
    markSummaryDirty: (value: string) => {
      editDraft(platform, { summary: value });
      resetMessages();
    },
    markBodyHtmlDirty: (value: string) => {
      editDraft(platform, { bodyHtml: value });
      resetMessages();
    },
    markCaptionDirty: (value: string) => {
      editDraft(platform, { captionText: value });
      resetMessages();
    },
    markTagsDirty: (value: readonly string[]) => {
      editDraft(platform, { tags: value });
      resetMessages();
    },
    handleBodyBlur: (value: string) => {
      editDraft(platform, { bodyHtml: value });
      // 失焦提交也要过内容判定：编辑器打开就会失焦一次，那一发不该写库
      const changed =
        articleWorkflowDraftHash({
          title: titleDraft,
          summary: summaryDraft,
          bodyHtml: value,
          captionText: captionDraft,
          tags: tagsDraft,
        }) !== hashOf(platform);
      if (savable && changed) {
        void saveProject("auto");
      }
    },
  };
}
