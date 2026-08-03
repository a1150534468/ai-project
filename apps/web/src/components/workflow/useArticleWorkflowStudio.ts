import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARTICLE_WORKFLOW_PLATFORMS,
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { ApiError } from "../../apiError";
import { useToast } from "../../motion";
import {
  createArticleWorkflowProject,
  deleteArticleWorkflowProject,
  generateArticleWorkflowImages,
  getArticleWorkflowBatch,
  getArticleWorkflowPricing,
  getArticleWorkflowProject,
  listArticleWorkflowHistory,
  regenerateArticleWorkflowImage,
  retryArticleWorkflowProject,
  rewriteArticleWorkflowProject,
  type ArticleWorkflowPricing,
  type ArticleWorkflowProject,
  type ArticleWorkflowProjectSummary,
  updateArticleWorkflowProject,
} from "../../workflowArticleApi";
import {
  articleWorkflowCreationConfigFromDraft,
  articleWorkflowCreationDraftFromProject,
  canSubmitArticleWorkflowCreationDraft,
  defaultArticleWorkflowCreationDraft,
  type ArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";
import {
  articleWorkflowBatchProgress,
  groupArticleWorkflowHistory,
  resolveActiveArticleWorkflowProject,
  shortPlatformLabel,
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
  const [creationDraft, setCreationDraft] = useState<ArticleWorkflowCreationDraft>(
    initialProject ? articleWorkflowCreationDraftFromProject(initialProject) : defaultArticleWorkflowCreationDraft(),
  );
  const [generateImages, setGenerateImages] = useState(initialProject?.creationConfig.generateImages ?? true);
  const [generationMode, setGenerationMode] = useState<ArticleWorkflowGenerationMode>(initialProject?.generationMode ?? "preserve-text");
  const [selectedPlatforms, setSelectedPlatforms] = useState<readonly ArticleWorkflowPlatform[]>(
    initialProject ? [initialProject.platform] : ARTICLE_WORKFLOW_PLATFORMS,
  );
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  /** 正在重试的行 id，用来禁用按钮防重复点击 */
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(null);
  const [deletingBatchKey, setDeletingBatchKey] = useState<string | null>(null);
  const [regeneratingSlot, setRegeneratingSlot] = useState<string | null>(null);
  const [generatingImageProjectIds, setGeneratingImageProjectIds] = useState<readonly string[]>([]);
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
  /** 只有成品行能存；failed / 生成中的行连脏标记都不打，自动保存自然不会启动 */
  const savable = canSaveArticleWorkflowStatus(project?.status);

  const titleDraft = titleDrafts[platform] ?? "";
  const summaryDraft = summaryDrafts[platform] ?? "";
  const bodyHtmlDraft = bodyHtmlDrafts[platform] ?? "";
  const captionDraft = captionDrafts[platform] ?? "";
  const tagsDraft = tagsDrafts[platform] ?? [];
  const sourceFormat: ArticleWorkflowSourceFormat = creationDraft.mode === "source"
    ? creationDraft.sourceFormat
    : "plain-text";
  const sourceText = creationDraft.mode === "source" ? creationDraft.sourceText : "";

  const historyBatches = useMemo(() => groupArticleWorkflowHistory(history), [history]);
  const batchProgress = useMemo(() => articleWorkflowBatchProgress(batchProjects), [batchProjects]);
  const batchBusy = batchProjects.some((item) => isBusyArticleWorkflowStatus(item.status));

  const markDirtyRaw = useCallback((target: ArticleWorkflowPlatform, next: boolean) => {
    setDirtyPlatforms((current) => (next
      ? (current.includes(target) ? current : [...current, target])
      : current.filter((item) => item !== target)));
  }, []);

  /** 打脏标记要看这行存不存得下去：failed / 生成中的行不打，免得挂着「待保存」又永远存不进 */
  const markDirty = useCallback((target: ArticleWorkflowPlatform, next: boolean) => {
    if (next && !canSaveArticleWorkflowStatus(batchProjects.find((item) => item.platform === target)?.status)) return;
    markDirtyRaw(target, next);
  }, [batchProjects, markDirtyRaw]);

  /**
   * 按内容决定脏标记，而不是按「有没有触发过 onChange」。
   *
   * 早先每次 onChange 都无条件打脏，1.5s 后自动保存就发车。于是编辑器载入时对
   * HTML 做的规范化（它不认识的标签被拍平）也被当成用户编辑存回库里，成品被冲掉。
   * 现在拿完整草稿的 hash 跟「上次保存的 hash」比：一致就撤脏标记，自动保存不发车；
   * 用户把内容改回原样也会自动退出待保存状态。
   *
   * 注意这只挡住「内容没变」的那一类。编辑器把内容真改了（规范化就属于这种）
   * hash 一定不同，仍然会存——那一层要靠编辑器自己只在用户真操作时才 onChange。
   */
  const syncDirtyByContent = useCallback((
    target: ArticleWorkflowPlatform,
    override: {
      readonly title?: string;
      readonly summary?: string;
      readonly bodyHtml?: string;
      readonly captionText?: string;
      readonly tags?: readonly string[];
    },
  ) => {
    const nextHash = articleWorkflowDraftHash({
      title: override.title ?? titleDrafts[target] ?? "",
      summary: override.summary ?? summaryDrafts[target] ?? "",
      bodyHtml: override.bodyHtml ?? bodyHtmlDrafts[target] ?? "",
      captionText: override.captionText ?? captionDrafts[target] ?? "",
      tags: override.tags ?? tagsDrafts[target] ?? [],
    });
    markDirty(target, nextHash !== lastSavedHashRef.current.get(target));
  }, [bodyHtmlDrafts, captionDrafts, markDirty, summaryDrafts, tagsDrafts, titleDrafts]);

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

    const sourceProject = details[0];
    if (force && sourceProject) {
      setCreationDraft(articleWorkflowCreationDraftFromProject(sourceProject));
      setGenerateImages(sourceProject.creationConfig.generateImages);
      setGenerationMode(sourceProject.generationMode);
      setSelectedPlatforms(
        ARTICLE_WORKFLOW_PLATFORMS.filter((item) => details.some((detail) => detail.platform === item)),
      );
    }

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
          const imageFailures = details.filter((item) => item.status === "ready" && item.error);
          const ready = details.length - failed.length;
          setNotice(ready > 0 ? `${ready} 个平台已生成` : "图文处理失败");
          if (failed.length > 0) {
            const names = failed.map((item) => shortPlatformLabel(item.platform)).join("、");
            setError(`${names}生成失败：${failed[0]?.error || "未知原因"}`);
          } else if (imageFailures.length > 0) {
            const names = imageFailures.map((item) => shortPlatformLabel(item.platform)).join("、");
            setError(`${names}配图失败：${imageFailures[0]?.error || "未知原因"}`);
          }
          onBalanceRefresh?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "刷新项目失败");
        }
      })();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [batchBusy, loadBatch, onBalanceRefresh, pollBatchId, pollProjectId, refreshHistory]);

  const canGenerate = canSubmitArticleWorkflowCreationDraft(creationDraft)
    && selectedPlatforms.length > 0
    && !creating;
  const canSave = Boolean(project && dirty && savable && !saving);
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
    // 兜底：后端对非 ready 行一律 409，这里先拦住，别让失败行被自动保存反复撞
    if (!canSaveArticleWorkflowStatus(project.status)) {
      markDirty(target, false);
      return false;
    }
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
      // 竞态：提交途中这行在服务端变成了 failed / 生成中。不当报错弹，静默刷一次这行状态
      if (err instanceof ApiError && err.status === 409) {
        markDirty(target, false);
        const latest = await getArticleWorkflowProject(token, project.id).catch(() => null);
        if (latest) {
          setBatchProjects((current) => current.map((item) => (item.id === latest.id ? withClonedManifest(latest) : item)));
        }
        return false;
      }
      const message = err instanceof Error ? err.message : "保存失败";
      setError(message);
      toast.show("err", message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [bodyHtmlDraft, captionDraft, markDirty, project, refreshHistory, summaryDraft, tagsDraft, titleDraft, toast, token]);

  // 只有 ready 行自动保存：failed 行放开的话，编辑器一打开就每 1.5s 撞一次 409
  useEffect(() => {
    if (!project || !dirty || saving || rewriting || !canSaveArticleWorkflowStatus(project.status)) return undefined;
    const timer = window.setTimeout(() => {
      void saveProject("auto");
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, project, rewriting, saveProject, saving]);

  const ensureCanLeaveDirty = () => {
    if (!anyDirty) return true;
    return typeof window === "undefined" || window.confirm("当前有未保存修改，确定切换项目吗？");
  };

  const resetToNewProject = () => {
    setBatchProjects([]);
    setActivePlatform(null);
    setTitleDrafts({});
    setSummaryDrafts({});
    setBodyHtmlDrafts({});
    setCaptionDrafts({});
    setTagsDrafts({});
    lastSavedHashRef.current.clear();
    setEditorSyncKey("");
    setCreationDraft(defaultArticleWorkflowCreationDraft());
    setGenerateImages(true);
    setGenerationMode("preserve-text");
    setSelectedPlatforms(ARTICLE_WORKFLOW_PLATFORMS);
    setRewriteInstruction("");
    setRewriteGenerationMode("preserve-text");
    setRewriteRegenerateImages(false);
    setDirtyPlatforms([]);
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
        setDirtyPlatforms([]);
        dirtyPlatformsRef.current = [];
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
      typeof window !== "undefined"
      && !window.confirm(`确定删除“${title}”吗？该批次下的所有平台内容都会被删除，且无法恢复。`)
    ) return;
    setDeletingBatchKey(entry.key);
    resetMessages();
    void (async () => {
      try {
        await deleteArticleWorkflowProject(token, entry.projectId);
        setHistory((current) => current.filter((item) => (
          entry.batchId ? item.batchId !== entry.batchId : item.id !== entry.projectId
        )));
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
        const creationConfig = articleWorkflowCreationConfigFromDraft(creationDraft, generateImages);
        const created = await createArticleWorkflowProject(token, {
          creationMode: creationDraft.mode,
          creationConfig,
          sourceFormat,
          sourceText: sourceText.trim(),
          generationMode: creationDraft.mode === "topic" ? "polish-text" : generationMode,
          platforms: selectedPlatforms,
          generateImages,
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

  const handleGenerateImages = (scope: "current" | "batch") => {
    if (!project || generatingImageProjectIds.length > 0) return;
    const targets = (scope === "current" ? [project] : batchProjects)
      .filter((item) => item.status === "ready" && item.imageManifestJson.some((image) => !image.imageUrl.trim()));
    if (targets.length === 0) return;
    void (async () => {
      const saved = dirty ? await saveProject("manual") : true;
      if (!saved) return;
      setGeneratingImageProjectIds(targets.map((item) => item.id));
      resetMessages();
      try {
        const results = await Promise.allSettled(
          targets.map((item) => generateArticleWorkflowImages(token, item.id)),
        );
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
    setCreationDraft: (value: ArticleWorkflowCreationDraft) => {
      setCreationDraft(value);
      resetMessages();
    },
    handleCreationModeChange: (mode: ArticleWorkflowCreationDraft["mode"]) => {
      setCreationDraft(defaultArticleWorkflowCreationDraft(mode));
      setGenerateImages(mode === "source");
      setGenerationMode(mode === "source" ? "preserve-text" : "polish-text");
      resetMessages();
    },
    setGenerateImages: (value: boolean) => {
      setGenerateImages(value);
      resetMessages();
    },
    setGenerationMode,
    setRewriteInstruction,
    setRewriteGenerationMode,
    setRewriteRegenerateImages,
    handleNewProject,
    handleSelectBatch,
    handleDeleteBatch,
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
    handleRetry,
    handleRegenerateImage,
    handleGenerateImages,
    markTitleDirty: (value: string) => {
      setTitleDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { title: value });
      resetMessages();
    },
    markSummaryDirty: (value: string) => {
      setSummaryDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { summary: value });
      resetMessages();
    },
    markBodyHtmlDirty: (value: string) => {
      setBodyHtmlDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { bodyHtml: value });
      resetMessages();
    },
    markCaptionDirty: (value: string) => {
      setCaptionDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { captionText: value });
      resetMessages();
    },
    markTagsDirty: (value: readonly string[]) => {
      setTagsDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { tags: value });
      resetMessages();
    },
    handleBodyBlur: (value: string) => {
      setBodyHtmlDrafts((current) => ({ ...current, [platform]: value }));
      syncDirtyByContent(platform, { bodyHtml: value });
      // 失焦提交也要过内容判定：编辑器打开就会失焦一次，那一发不该写库
      const changed = articleWorkflowDraftHash({
        title: titleDraft,
        summary: summaryDraft,
        bodyHtml: value,
        captionText: captionDraft,
        tags: tagsDraft,
      }) !== lastSavedHashRef.current.get(platform);
      if (savable && changed) {
        void saveProject("auto");
      }
    },
  };
}
