import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { useToast } from "../../motion";
import {
  createArticleWorkflowProject,
  getArticleWorkflowBatch,
  getArticleWorkflowPricing,
  getArticleWorkflowProject,
  listArticleWorkflowHistory,
  regenerateArticleWorkflowImage,
  rewriteArticleWorkflowProject,
  type ArticleWorkflowPricing,
  type ArticleWorkflowProject,
  type ArticleWorkflowProjectSummary,
  updateArticleWorkflowProject,
} from "../../workflowArticleApi";
import {
  articleWorkflowBatchProgress,
  groupArticleWorkflowHistory,
  resolveActiveArticleWorkflowProject,
  shortPlatformLabel,
} from "./articleWorkflowBatchModel";
import { createArticleWorkflowCopyActions } from "./articleWorkflowCopyActions";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import {
  articleWorkflowDraftHash,
  cloneImageManifest,
  isBusyArticleWorkflowStatus,
} from "./articleWorkflowStudioModel";

const AUTOSAVE_DELAY_MS = 1500;

type DraftRecord = Partial<Record<ArticleWorkflowPlatform, string>>;
type TagsRecord = Partial<Record<ArticleWorkflowPlatform, readonly string[]>>;

export interface ArticleWorkflowBatchSelection {
  readonly key: string;
  readonly batchId: string | null;
  readonly projectId: string;
}

function draftHashOf(project: ArticleWorkflowProject): string {
  return articleWorkflowDraftHash({
    title: project.title,
    summary: project.summary,
    bodyHtml: project.bodyHtml,
    captionText: project.captionText,
    tags: project.tags,
  });
}

function withClonedManifest(project: ArticleWorkflowProject): ArticleWorkflowProject {
  return { ...project, imageManifestJson: cloneImageManifest(project.imageManifestJson) };
}

export function useArticleWorkflowStudio({
  token,
  onBalanceRefresh,
  initialHistory,
  initialProject = null,
  initialBootstrapping,
}: ArticleWorkflowStudioProps) {
  const toast = useToast();
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  /** 每个平台各自记住上次保存的 hash，切页签不会互相误判脏 */
  const lastSavedHashRef = useRef(new Map<ArticleWorkflowPlatform, string>());
  /** 轮询回调里要读最新脏状态，用 ref 避免把轮询 effect 绑到 state 上反复重建 */
  const dirtyPlatformsRef = useRef<readonly ArticleWorkflowPlatform[]>([]);
  const [editorSyncKey, setEditorSyncKey] = useState("");
  const [bootstrapping, setBootstrapping] = useState(initialBootstrapping ?? !initialHistory);
  const [history, setHistory] = useState<readonly ArticleWorkflowProjectSummary[]>(initialHistory ?? []);
  const [batchProjects, setBatchProjects] = useState<readonly ArticleWorkflowProject[]>(
    initialProject ? [initialProject] : [],
  );
  const [activePlatform, setActivePlatform] = useState<ArticleWorkflowPlatform | null>(
    initialProject?.platform ?? null,
  );
  const [pricing, setPricing] = useState<ArticleWorkflowPricing | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<DraftRecord>(
    initialProject ? { [initialProject.platform]: initialProject.title } : {},
  );
  const [summaryDrafts, setSummaryDrafts] = useState<DraftRecord>(
    initialProject ? { [initialProject.platform]: initialProject.summary } : {},
  );
  const [bodyHtmlDrafts, setBodyHtmlDrafts] = useState<DraftRecord>(
    initialProject ? { [initialProject.platform]: initialProject.bodyHtml } : {},
  );
  const [captionDrafts, setCaptionDrafts] = useState<DraftRecord>(
    initialProject ? { [initialProject.platform]: initialProject.captionText } : {},
  );
  const [tagsDrafts, setTagsDrafts] = useState<TagsRecord>(
    initialProject ? { [initialProject.platform]: initialProject.tags } : {},
  );
  const [sourceFormat, setSourceFormat] = useState<ArticleWorkflowSourceFormat>("plain-text");
  const [generationMode, setGenerationMode] = useState<ArticleWorkflowGenerationMode>("preserve-text");
  const [selectedPlatforms, setSelectedPlatforms] = useState<readonly ArticleWorkflowPlatform[]>(
    ARTICLE_WORKFLOW_PLATFORMS,
  );
  const [sourceText, setSourceText] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [regeneratingSlot, setRegeneratingSlot] = useState<string | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteGenerationMode, setRewriteGenerationMode] = useState<ArticleWorkflowGenerationMode>(initialProject?.generationMode ?? "preserve-text");
  const [rewriteRegenerateImages, setRewriteRegenerateImages] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 脏标记按平台记，避免切页签后把别的平台的未保存改动一起提交 */
  const [dirtyPlatforms, setDirtyPlatforms] = useState<readonly ArticleWorkflowPlatform[]>([]);

  dirtyPlatformsRef.current = dirtyPlatforms;

  const project = useMemo(
    () => resolveActiveArticleWorkflowProject(batchProjects, activePlatform),
    [activePlatform, batchProjects],
  );
  const platform = project?.platform ?? "wechat";
  const platformConfig = articleWorkflowPlatformConfig(platform);
  const captionPlatform = platformConfig.outputKind === "caption";
  const selectedBatchKey = project
    ? (project.batchId ? `batch:${project.batchId}` : `project:${project.id}`)
    : null;
  const dirty = dirtyPlatforms.includes(platform);
  const anyDirty = dirtyPlatforms.length > 0;

  const titleDraft = titleDrafts[platform] ?? "";
  const summaryDraft = summaryDrafts[platform] ?? "";
  const bodyHtmlDraft = bodyHtmlDrafts[platform] ?? "";
  const captionDraft = captionDrafts[platform] ?? "";
  const tagsDraft = tagsDrafts[platform] ?? [];

  const historyBatches = useMemo(() => groupArticleWorkflowHistory(history), [history]);
  const batchProgress = useMemo(() => articleWorkflowBatchProgress(batchProjects), [batchProjects]);
  const batchBusy = batchProjects.some((item) => isBusyArticleWorkflowStatus(item.status));

  const markDirty = useCallback((target: ArticleWorkflowPlatform, next: boolean) => {
    setDirtyPlatforms((current) => (next
      ? (current.includes(target) ? current : [...current, target])
      : current.filter((item) => item !== target)));
  }, []);

  /**
   * 把批次的服务端状态写回草稿。
   * force=false 时保留仍在编辑的平台草稿（生成中的行没有用户改动，一律覆盖）。
   */
  const hydrateProjects = useCallback((
    details: readonly ArticleWorkflowProject[],
    args?: { readonly force?: boolean; readonly focusPlatform?: ArticleWorkflowPlatform | null },
  ) => {
    const force = args?.force ?? true;
    setBatchProjects(details.map(withClonedManifest));

    const nextTitles: DraftRecord = {};
    const nextSummaries: DraftRecord = {};
    const nextBodies: DraftRecord = {};
    const nextCaptions: DraftRecord = {};
    const nextTags: TagsRecord = {};
    const keptDirty: ArticleWorkflowPlatform[] = [];
    for (const detail of details) {
      const overwrite = force
        || isBusyArticleWorkflowStatus(detail.status)
        || !dirtyPlatformsRef.current.includes(detail.platform);
      if (!overwrite) {
        keptDirty.push(detail.platform);
        continue;
      }
      nextTitles[detail.platform] = detail.title;
      nextSummaries[detail.platform] = detail.summary;
      nextBodies[detail.platform] = detail.bodyHtml;
      nextCaptions[detail.platform] = detail.captionText;
      nextTags[detail.platform] = detail.tags;
      lastSavedHashRef.current.set(detail.platform, draftHashOf(detail));
    }
    setTitleDrafts((current) => ({ ...current, ...nextTitles }));
    setSummaryDrafts((current) => ({ ...current, ...nextSummaries }));
    setBodyHtmlDrafts((current) => ({ ...current, ...nextBodies }));
    setCaptionDrafts((current) => ({ ...current, ...nextCaptions }));
    setTagsDrafts((current) => ({ ...current, ...nextTags }));
    setDirtyPlatforms((current) => current.filter((item) => keptDirty.includes(item)));

    const requestedFocus = args?.focusPlatform ?? null;
    const inBatch = details.some((item) => item.platform === activePlatform);
    const focus = requestedFocus
      ?? (inBatch ? activePlatform : null);
    const focused = resolveActiveArticleWorkflowProject(details, focus);
    if (focused) {
      setActivePlatform(focused.platform);
      setRewriteGenerationMode(focused.generationMode);
      setEditorSyncKey(`${focused.id}:${lastSavedHashRef.current.get(focused.platform) ?? ""}`);
    }
    return details;
  }, [activePlatform]);

  const resetMessages = () => {
    setError("");
    setNotice("");
  };

  const refreshHistory = useCallback(async () => {
    setHistory(await listArticleWorkflowHistory(token));
  }, [token]);

  const refreshPricing = useCallback(async () => {
    try {
      setPricing(await getArticleWorkflowPricing(token));
    } catch {
      setPricing(null);
    }
  }, [token]);

  /** 批次载入；存量无 batchId 的行退回单项目接口 */
  const loadBatch = useCallback(async (args: {
    readonly batchId: string | null;
    readonly projectId: string;
    readonly force?: boolean;
    readonly focusPlatform?: ArticleWorkflowPlatform | null;
  }) => {
    const details = args.batchId
      ? (await getArticleWorkflowBatch(token, args.batchId)).projects
      : [await getArticleWorkflowProject(token, args.projectId)];
    return hydrateProjects(details, {
      force: args.force ?? true,
      focusPlatform: args.focusPlatform ?? (args.batchId ? null : details[0]?.platform ?? null),
    });
  }, [hydrateProjects, token]);

  useEffect(() => {
    if (initialProject) {
      const hash = draftHashOf(initialProject);
      lastSavedHashRef.current.set(initialProject.platform, hash);
      setEditorSyncKey(`${initialProject.id}:${hash}`);
    }
  }, [initialProject]);

  useEffect(() => {
    if (initialHistory) {
      setBootstrapping(false);
      void refreshPricing();
      return;
    }
    void (async () => {
      try {
        await Promise.all([refreshHistory(), refreshPricing()]);
      } catch {
        setError("加载图文工作台失败");
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [initialHistory, refreshHistory, refreshPricing]);

  const pollBatchId = batchProjects[0]?.batchId ?? null;
  const pollProjectId = batchProjects.find((item) => isBusyArticleWorkflowStatus(item.status))?.id
    ?? batchProjects[0]?.id
    ?? "";

  useEffect(() => {
    if (!batchBusy || !pollProjectId) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          // 已完成的平台可能正在被编辑，force=false 保住那份草稿
          const details = await loadBatch({
            batchId: pollBatchId,
            projectId: pollProjectId,
            force: false,
          });
          await refreshHistory();
          if (details.some((item) => isBusyArticleWorkflowStatus(item.status))) return;
          const failed = details.filter((item) => item.status === "failed");
          const ready = details.length - failed.length;
          setNotice(ready > 0 ? `${ready} 个平台已生成` : "图文处理失败");
          if (failed.length > 0) {
            const names = failed.map((item) => shortPlatformLabel(item.platform)).join("、");
            setError(`${names}生成失败：${failed[0]?.error || "未知原因"}`);
          }
          onBalanceRefresh?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新项目失败");
        }
      })();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [batchBusy, loadBatch, onBalanceRefresh, pollBatchId, pollProjectId, refreshHistory]);

  const canGenerate = sourceText.trim().length > 0 && selectedPlatforms.length > 0 && !creating;
  const canSave = Boolean(project && dirty && !isBusyArticleWorkflowStatus(project.status) && !saving);
  const canRewrite = Boolean(project && rewriteInstruction.trim() && !rewriting && !saving && !isBusyArticleWorkflowStatus(project.status));

  const {
    handleCopyBody,
    handleCopyTitle,
    handleCopySummary,
    handleCopyCaption,
    handleCopyTags,
  } = createArticleWorkflowCopyActions({
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

  const saveProject = useCallback(async (mode: "manual" | "auto" = "manual"): Promise<boolean> => {
    if (!project) return false;
    const target = project.platform;
    const nextHash = articleWorkflowDraftHash({
      title: titleDraft,
      summary: summaryDraft,
      bodyHtml: bodyHtmlDraft,
      captionText: captionDraft,
      tags: tagsDraft,
    });
    if (nextHash === lastSavedHashRef.current.get(target)) {
      markDirty(target, false);
      return true;
    }
    setSaving(true);
    setError("");
    if (mode === "manual") setNotice("");
    try {
      const isCaption = articleWorkflowPlatformConfig(target).outputKind === "caption";
      const saved = await updateArticleWorkflowProject(token, project.id, isCaption
        ? {
          title: titleDraft.trim(),
          summary: summaryDraft.trim(),
          captionText: captionDraft.trim(),
          tags: tagsDraft.map((tag) => tag.trim()).filter(Boolean),
        }
        : {
          title: titleDraft.trim(),
          summary: summaryDraft.trim(),
          bodyHtml: bodyHtmlDraft.trim(),
        });
      setBatchProjects((current) => current.map((item) => (item.id === saved.id ? withClonedManifest(saved) : item)));
      lastSavedHashRef.current.set(target, draftHashOf(saved));
      markDirty(target, false);
      setNotice(mode === "auto" ? "已自动保存" : "已保存修改");
      if (mode === "manual") toast.show("ok", "已保存修改");
      await refreshHistory();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存失败";
      setError(message);
      toast.show("err", message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [bodyHtmlDraft, captionDraft, markDirty, project, refreshHistory, summaryDraft, tagsDraft, titleDraft, toast, token]);

  useEffect(() => {
    if (!project || !dirty || saving || rewriting || isBusyArticleWorkflowStatus(project.status)) return undefined;
    const timer = window.setTimeout(() => {
      void saveProject("auto");
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, project, rewriting, saveProject, saving]);

  const ensureCanLeaveDirty = () => {
    if (!anyDirty) return true;
    return typeof window === "undefined" || window.confirm("当前有未保存修改，确定切换项目吗？");
  };

  const handleNewProject = () => {
    if (!ensureCanLeaveDirty()) return;
    setBatchProjects([]);
    setActivePlatform(null);
    setTitleDrafts({});
    setSummaryDrafts({});
    setBodyHtmlDrafts({});
    setCaptionDrafts({});
    setTagsDrafts({});
    lastSavedHashRef.current.clear();
    setEditorSyncKey("");
    setSourceFormat("plain-text");
    setGenerationMode("preserve-text");
    setSelectedPlatforms(ARTICLE_WORKFLOW_PLATFORMS);
    setSourceText("");
    setRewriteInstruction("");
    setRewriteGenerationMode("preserve-text");
    setRewriteRegenerateImages(false);
    setDirtyPlatforms([]);
    resetMessages();
  };

  const handleSelectBatch = (entry: ArticleWorkflowBatchSelection) => {
    if (entry.key === selectedBatchKey || !ensureCanLeaveDirty()) return;
    void (async () => {
      try {
        resetMessages();
        setDirtyPlatforms([]);
        dirtyPlatformsRef.current = [];
        setActivePlatform(null);
        await loadBatch({ batchId: entry.batchId, projectId: entry.projectId, force: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载项目失败");
      }
    })();
  };

  const handleSelectPlatform = (next: ArticleWorkflowPlatform) => {
    if (next === activePlatform) return;
    const target = batchProjects.find((item) => item.platform === next);
    if (!target) return;
    setActivePlatform(next);
    setRewriteGenerationMode(target.generationMode);
    setEditorSyncKey(`${target.id}:${lastSavedHashRef.current.get(next) ?? ""}`);
    resetMessages();
  };

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
    resetMessages();
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    setCreating(true);
    resetMessages();
    void (async () => {
      try {
        const created = await createArticleWorkflowProject(token, {
          sourceFormat,
          sourceText: sourceText.trim(),
          generationMode,
          platforms: selectedPlatforms,
        });
        setDirtyPlatforms([]);
        dirtyPlatformsRef.current = [];
        const details = await loadBatch({
          batchId: created.batchId,
          projectId: created.projectId,
          force: true,
          focusPlatform: created.projects[0]?.platform ?? null,
        });
        await refreshHistory();
        setNotice(`已开始生成 ${details.length} 个平台的图文`);
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
        setBatchProjects((rows) => rows.map((item) => (item.id === updated.id ? withClonedManifest(updated) : item)));
        lastSavedHashRef.current.set(current.platform, draftHashOf(updated));
        setBodyHtmlDrafts((drafts) => ({ ...drafts, [current.platform]: updated.bodyHtml }));
        markDirty(current.platform, false);
        setEditorSyncKey(`${updated.id}:${lastSavedHashRef.current.get(current.platform) ?? ""}`);
        setNotice("图片已更新");
        toast.show("ok", "图片已更新");
        await refreshHistory();
        onBalanceRefresh?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "图片重生失败";
        setError(message);
        toast.show("err", message);
      } finally {
        setRegeneratingSlot(null);
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
    selectedPlatforms,
    dirtyPlatforms,
    project,
    pricing,
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
    regeneratingSlot,
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
    setSourceFormat,
    setGenerationMode,
    setSourceText: (value: string) => {
      setSourceText(value);
      resetMessages();
    },
    setRewriteInstruction,
    setRewriteGenerationMode,
    setRewriteRegenerateImages,
    handleNewProject,
    handleSelectBatch,
    handleSelectPlatform,
    handleTogglePlatform,
    handleGenerate,
    handleSave: () => saveProject("manual"),
    handleCopyBody,
    handleCopyTitle,
    handleCopySummary,
    handleCopyCaption,
    handleCopyTags,
    handleRewrite,
    handleRegenerateImage,
    markTitleDirty: (value: string) => {
      setTitleDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      resetMessages();
    },
    markSummaryDirty: (value: string) => {
      setSummaryDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      resetMessages();
    },
    markBodyHtmlDirty: (value: string) => {
      setBodyHtmlDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      resetMessages();
    },
    markCaptionDirty: (value: string) => {
      setCaptionDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      resetMessages();
    },
    markTagsDirty: (value: readonly string[]) => {
      setTagsDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      resetMessages();
    },
    handleBodyBlur: (value: string) => {
      setBodyHtmlDrafts((current) => ({ ...current, [platform]: value }));
      markDirty(platform, true);
      if (project && !isBusyArticleWorkflowStatus(project.status)) {
        void saveProject("auto");
      }
    },
  };
}
